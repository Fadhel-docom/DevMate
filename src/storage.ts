export type Task = { id: string; title: string; done: boolean; createdAt: number };
export type Project = { id: string; name: string; tasks: Task[] };

export const STORAGE_KEY = "devmate-workspace-v1";
/** Backup slot 1. This is the key earlier versions of the app already used, so existing backups stay valid. */
export const BACKUP_KEY = "devmate-workspace-v1.unreadable-backup";
/** Upper bound on backup slots, so unreadable data can never fill the browser storage without limit. */
export const MAX_BACKUPS = 20;

/** Slot 1 is BACKUP_KEY; slot n (n >= 2) is BACKUP_KEY + "." + n. Deterministic: no clock, no randomness. */
export function backupKey(slot: number): string {
  return slot <= 1 ? BACKUP_KEY : `${BACKUP_KEY}.${slot}`;
}

const starter: Project[] = [{ id: "starter", name: "My first project", tasks: [] }];

type ReadableStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;
type WritableStorage = Pick<Storage, "setItem"> & Partial<Pick<Storage, "getItem">>;
type BackupStorage = Pick<Storage, "getItem" | "setItem">;

export type LoadStatus =
  | "ok" // stored data was valid and is returned unchanged
  | "empty" // nothing (or an empty list) was stored; starter project returned
  | "recovered" // some entries were invalid; the valid ones are returned
  | "invalid" // JSON parsed but nothing usable matched the Project/Task shape
  | "corrupt" // stored text is not valid JSON
  | "unavailable"; // storage could not be read at all

export type LoadResult = {
  projects: Project[];
  status: LoadStatus;
  droppedProjects: number;
  droppedTasks: number;
  repairedProjects: number;
  /** True only when a verified copy of the unreadable original exists in a backup slot (new or already stored). */
  backedUp: boolean;
  /** The slot key that holds the verified copy, or null when no copy exists. */
  backupKey: string | null;
};

export type SaveFailureReason =
  | "unavailable"
  | "quota"
  | "invalid-data"
  | "serialize"
  | "verify"
  | "protect-original" // stored data is unreadable (or only partly readable) and could not be copied first
  | "unknown";
export type SaveResult =
  | { ok: true; backupKey?: string } // backupKey is set only when stored unreadable data had to be backed up first
  | { ok: false; reason: SaveFailureReason; message: string };

type Parsed = { projects: Project[]; droppedProjects: number; droppedTasks: number; repairedProjects: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const { id, title, done, createdAt } = value;
  if (typeof id !== "string" || id === "") return null;
  if (typeof title !== "string") return null;
  if (typeof done !== "boolean") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return { id, title, done, createdAt };
}

/**
 * Validates untrusted data against the Project/Task shape. Only known fields are copied
 * into fresh objects. Invalid tasks and projects are dropped and counted, never invented.
 * A project with a valid id and name but a missing or non-array `tasks` keeps its identity
 * with an empty task list and is counted as repaired.
 */
export function parseProjects(value: unknown): Parsed {
  const result: Parsed = { projects: [], droppedProjects: 0, droppedTasks: 0, repairedProjects: 0 };
  if (!Array.isArray(value)) return result;
  const projectIds = new Set<string>();
  for (const rawProject of value) {
    if (!isRecord(rawProject)) { result.droppedProjects += 1; continue; }
    const { id, name, tasks: rawTasks } = rawProject;
    if (typeof id !== "string" || id === "" || typeof name !== "string" || projectIds.has(id)) {
      result.droppedProjects += 1;
      continue;
    }
    projectIds.add(id);
    const tasks: Task[] = [];
    if (Array.isArray(rawTasks)) {
      const taskIds = new Set<string>();
      for (const rawTask of rawTasks) {
        const task = parseTask(rawTask);
        if (!task || taskIds.has(task.id)) { result.droppedTasks += 1; continue; }
        taskIds.add(task.id);
        tasks.push(task);
      }
    } else {
      result.repairedProjects += 1;
    }
    result.projects.push({ id, name, tasks });
  }
  return result;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014;
}

/** Returns the browser's localStorage, or null when it is missing or access is blocked. */
export function getBrowserStorage(host: { localStorage?: Storage } = globalThis): Storage | null {
  try {
    return host.localStorage ?? null;
  } catch {
    return null;
  }
}

type Inspection =
  | { kind: "empty" }
  | { kind: "ok"; parsed: Parsed }
  | { kind: "recovered"; parsed: Parsed }
  | { kind: "invalid"; parsed: Parsed }
  | { kind: "corrupt" };

/**
 * Classifies raw stored text. Only "ok" and "empty" are safe to overwrite; the rest are not.
 * "empty" means the key is absent (handled by the callers) or holds the valid empty list "[]".
 * An empty string is NOT empty storage: it is not valid JSON and is not the project format, so it is "corrupt".
 */
function inspectRaw(raw: string): Inspection {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (Array.isArray(json) && json.length === 0) return { kind: "empty" };
  const parsed = parseProjects(json);
  if (parsed.projects.length === 0) return { kind: "invalid", parsed };
  const lossless = parsed.droppedProjects === 0 && parsed.droppedTasks === 0 && parsed.repairedProjects === 0;
  return { kind: lossless ? "ok" : "recovered", parsed };
}

type BackupFailure = "read-only" | "read-error" | "slots-full" | "write-failed" | "verify";
type BackupOutcome = { ok: true; key: string; created: boolean } | { ok: false; reason: BackupFailure };

/**
 * Copies unreadable raw text into the first free backup slot. It never overwrites a slot that it
 * sees in use, never throws, and reports success only after reading the copy back. This is not a
 * guarantee under concurrency: two tabs can read the same slot as free and both write to it, so one
 * copy can be lost (no locking; see the residual risks in docs/OPERATIONS-ROOM.md entry 31). If an identical copy
 * is already stored it is reused, so reading the same data again does not fill up the slots.
 */
function backUpUnreadable(storage: ReadableStorage, raw: string): BackupOutcome {
  if (!storage.setItem) return { ok: false, reason: "read-only" };
  let freeKey: string | null = null;
  try {
    for (let slot = 1; slot <= MAX_BACKUPS; slot += 1) {
      const key = backupKey(slot);
      const existing = storage.getItem(key);
      if (existing === null) {
        if (freeKey === null) freeKey = key;
      } else if (existing === raw) {
        return { ok: true, key, created: false };
      }
    }
  } catch {
    return { ok: false, reason: "read-error" };
  }
  if (freeKey === null) return { ok: false, reason: "slots-full" };
  try {
    storage.setItem(freeKey, raw);
  } catch {
    return { ok: false, reason: "write-failed" };
  }
  try {
    if (storage.getItem(freeKey) !== raw) return { ok: false, reason: "verify" };
  } catch {
    return { ok: false, reason: "verify" };
  }
  return { ok: true, key: freeKey, created: true };
}

const emptyResult = (status: LoadStatus): LoadResult => ({
  projects: starter,
  status,
  droppedProjects: 0,
  droppedTasks: 0,
  repairedProjects: 0,
  backedUp: false,
  backupKey: null
});

function backupFields(outcome: BackupOutcome): Pick<LoadResult, "backedUp" | "backupKey"> {
  return outcome.ok ? { backedUp: true, backupKey: outcome.key } : { backedUp: false, backupKey: null };
}

/** Reads and validates stored projects. Never throws. Raw data that cannot be used as-is is backed up (a slot seen in use is not overwritten; see the concurrency note on backUpUnreadable). */
export function readProjects(storage: ReadableStorage | null = getBrowserStorage()): LoadResult {
  if (!storage) return emptyResult("unavailable");
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return emptyResult("unavailable");
  }
  if (raw === null) return emptyResult("empty");

  const inspected = inspectRaw(raw);
  switch (inspected.kind) {
    case "empty":
      return emptyResult("empty");
    case "ok":
      return { ...inspected.parsed, status: "ok", backedUp: false, backupKey: null };
    case "recovered":
      return { ...inspected.parsed, status: "recovered", ...backupFields(backUpUnreadable(storage, raw)) };
    case "invalid":
      return {
        ...emptyResult("invalid"),
        droppedProjects: inspected.parsed.droppedProjects,
        ...backupFields(backUpUnreadable(storage, raw))
      };
    case "corrupt":
      return { ...emptyResult("corrupt"), ...backupFields(backUpUnreadable(storage, raw)) };
  }
}

/** Backward-compatible wrapper that returns only the projects. Never throws. */
export function loadProjects(storage?: ReadableStorage | null): Project[] {
  return readProjects(storage === undefined ? getBrowserStorage() : storage).projects;
}

type Guard = { ok: true; backupKey?: string } | Extract<SaveResult, { ok: false }>;

/**
 * Called before every write. If what is currently stored cannot be used as-is (corrupt, wrong
 * shape, or only partly valid), a verified copy must exist in a backup slot before it may be
 * replaced. If no copy can be made, the write is refused and the original stays untouched.
 */
function protectStoredOriginal(target: WritableStorage): Guard {
  if (!target.getItem) return { ok: true }; // a write-only storage cannot be inspected
  let raw: string | null;
  try {
    raw = target.getItem(STORAGE_KEY);
  } catch (error) {
    return { ok: false, reason: "unavailable", message: `Browser storage could not be read: ${describeError(error)}` };
  }
  if (raw === null) return { ok: true };
  const kind = inspectRaw(raw).kind;
  if (kind === "empty" || kind === "ok") return { ok: true };
  const outcome = backUpUnreadable(target as BackupStorage, raw);
  if (outcome.ok) return { ok: true, backupKey: outcome.key };
  return {
    ok: false,
    reason: "protect-original",
    message: `The stored data is unreadable and could not be backed up (${outcome.reason}); it was left untouched.`
  };
}

/**
 * Writes projects and reports the real outcome. Never throws. Data that does not match the
 * Project/Task shape is refused before touching storage. Stored data that is unreadable (or only
 * partly readable) is not replaced unless a verified backup copy of it exists (checked just before
 * the write; another tab can still change storage in between, so this is not a concurrency guarantee). A successful
 * write is read back when the storage supports it. A failed setItem leaves the previous value in place.
 */
export function saveProjects(projects: Project[], storage?: WritableStorage | null): SaveResult {
  const target = storage === undefined ? getBrowserStorage() : storage;
  if (!target) return { ok: false, reason: "unavailable", message: "Browser storage is not available." };

  const checked = parseProjects(projects);
  if (checked.droppedProjects > 0 || checked.droppedTasks > 0 || checked.repairedProjects > 0) {
    return { ok: false, reason: "invalid-data", message: "Refused to save data that does not match the project format." };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(checked.projects); // only known fields are persisted
  } catch (error) {
    return { ok: false, reason: "serialize", message: describeError(error) };
  }

  const guard = protectStoredOriginal(target);
  if (!guard.ok) return guard;

  try {
    target.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: "quota", message: "Browser storage is full." };
    const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
    if (name === "SecurityError") return { ok: false, reason: "unavailable", message: "Browser storage is blocked." };
    return { ok: false, reason: "unknown", message: describeError(error) };
  }

  if (target.getItem) {
    try {
      if (target.getItem(STORAGE_KEY) !== serialized) {
        return { ok: false, reason: "verify", message: "The saved data could not be read back." };
      }
    } catch (error) {
      return { ok: false, reason: "verify", message: describeError(error) };
    }
  }
  return guard.backupKey === undefined ? { ok: true } : { ok: true, backupKey: guard.backupKey };
}
