export type Task = { id: string; title: string; done: boolean; createdAt: number };
export type Project = { id: string; name: string; tasks: Task[] };

export const STORAGE_KEY = "devmate-workspace-v1";
export const BACKUP_KEY = "devmate-workspace-v1.unreadable-backup";

const starter: Project[] = [{ id: "starter", name: "My first project", tasks: [] }];

type ReadableStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;
type WritableStorage = Pick<Storage, "setItem"> & Partial<Pick<Storage, "getItem">>;

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
  backedUp: boolean;
};

export type SaveFailureReason = "unavailable" | "quota" | "invalid-data" | "serialize" | "verify" | "unknown";
export type SaveResult = { ok: true } | { ok: false; reason: SaveFailureReason; message: string };

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

function backUpUnreadable(storage: ReadableStorage, raw: string): boolean {
  if (!storage.setItem) return false;
  try {
    if (storage.getItem(BACKUP_KEY) !== null) return false; // keep the first backup; never overwrite it
    storage.setItem(BACKUP_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

const emptyResult = (status: LoadStatus): LoadResult => ({
  projects: starter,
  status,
  droppedProjects: 0,
  droppedTasks: 0,
  repairedProjects: 0,
  backedUp: false
});

/** Reads and validates stored projects. Never throws. Raw data that cannot be used as-is is backed up once. */
export function readProjects(storage: ReadableStorage | null = getBrowserStorage()): LoadResult {
  if (!storage) return emptyResult("unavailable");
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return emptyResult("unavailable");
  }
  if (raw === null || raw === "") return emptyResult("empty");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ...emptyResult("corrupt"), backedUp: backUpUnreadable(storage, raw) };
  }

  if (Array.isArray(parsedJson) && parsedJson.length === 0) return emptyResult("empty");

  const parsed = parseProjects(parsedJson);
  const lossless = parsed.droppedProjects === 0 && parsed.droppedTasks === 0 && parsed.repairedProjects === 0;
  if (parsed.projects.length === 0) {
    return { ...emptyResult("invalid"), droppedProjects: parsed.droppedProjects, backedUp: backUpUnreadable(storage, raw) };
  }
  if (lossless) return { ...parsed, status: "ok", backedUp: false };
  return { ...parsed, status: "recovered", backedUp: backUpUnreadable(storage, raw) };
}

/** Backward-compatible wrapper that returns only the projects. Never throws. */
export function loadProjects(storage?: ReadableStorage | null): Project[] {
  return readProjects(storage === undefined ? getBrowserStorage() : storage).projects;
}

/**
 * Writes projects and reports the real outcome. Never throws. Data that does not match the
 * Project/Task shape is refused before touching storage, and a successful write is read back
 * when the storage supports it. A failed setItem leaves the previously stored value in place.
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
  return { ok: true };
}
