export type Task = { id: string; title: string; done: boolean; createdAt: number; [key: string]: unknown };
export type Project = { id: string; name: string; tasks: Task[]; [key: string]: unknown };

export const STORAGE_KEY = "devmate-workspace-v1";
export const BACKUP_KEY = "devmate-workspace-v1.unreadable-backup";
export const MAX_BACKUPS = 20;
export const STORAGE_LOCK_NAME = "devmate-workspace-v1";
export const DEFAULT_LOCK_TIMEOUT_MS = 8000;

export type LoadStatus = "ok" | "empty" | "recovered" | "invalid" | "corrupt" | "unavailable";
export type LoadResult = {
  projects: Project[]; status: LoadStatus; droppedProjects: number; droppedTasks: number;
  repairedProjects: number; backedUp: boolean; backupKey: string | null; storageRaw: string | null;
};
export type SaveFailureReason =
  | "unavailable" | "quota" | "invalid-data" | "serialize" | "verify" | "protect-original"
  | "unknown" | "conflict" | "lock-unavailable" | "lock-timeout" | "lock-error" | "not-found" | "invalid-key";
export type SaveResult = { ok: true; backupKey?: string } | { ok: false; reason: SaveFailureReason; message: string };
export type BackupReason = "corrupt" | "invalid" | "recovered" | "pre-restore";
export type BackupInfo = {
  key: string; slot: number; createdAt: number | null; reason: BackupReason | null;
  parseable: boolean; restorable: boolean; projectCount: number | null; preview: string;
};
type Parsed = { projects: Project[]; droppedProjects: number; droppedTasks: number; repairedProjects: number };
type StorageLike = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;
type ReadableStorage = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;
type WritableStorage = Pick<Storage, "setItem"> & Partial<Pick<Storage, "getItem">>;

const starter: Project[] = [{ id: "starter", name: "My first project", tasks: [] }];
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BACKUP_REASONS = new Set<BackupReason>(["corrupt", "invalid", "recovered", "pre-restore"]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sanitizeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || depth > 40 || seen.has(value as object)) return undefined;
  seen.add(value as object);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitizeValue(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) { seen.delete(value as object); return undefined; }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const safe = sanitizeValue(value[key], seen, depth + 1);
    if (safe !== undefined) Object.defineProperty(result, key, { value: safe, enumerable: true, configurable: true, writable: true });
  }
  seen.delete(value);
  return result;
}
function collectExtras(source: Record<string, unknown>, known: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}, excluded = new Set(known);
  for (const key of Object.keys(source)) {
    if (excluded.has(key) || DANGEROUS_KEYS.has(key)) continue;
    const safe = sanitizeValue(source[key]);
    if (safe !== undefined) Object.defineProperty(result, key, { value: safe, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function parseTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const { id, title, done, createdAt } = value;
  if (typeof id !== "string" || !id || typeof title !== "string" || typeof done !== "boolean" ||
      typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return { ...collectExtras(value, ["id", "title", "done", "createdAt"]), id, title, done, createdAt };
}
export function parseProjects(value: unknown): Parsed {
  const result: Parsed = { projects: [], droppedProjects: 0, droppedTasks: 0, repairedProjects: 0 };
  if (!Array.isArray(value)) return result;
  const projectIds = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) { result.droppedProjects++; continue; }
    const { id, name, tasks: rawTasks } = raw;
    if (typeof id !== "string" || !id || typeof name !== "string" || projectIds.has(id)) { result.droppedProjects++; continue; }
    projectIds.add(id);
    const tasks: Task[] = [];
    if (Array.isArray(rawTasks)) {
      const taskIds = new Set<string>();
      for (const rawTask of rawTasks) {
        const task = parseTask(rawTask);
        if (!task || taskIds.has(task.id)) { result.droppedTasks++; continue; }
        taskIds.add(task.id); tasks.push(task);
      }
    } else result.repairedProjects++;
    result.projects.push({ ...collectExtras(raw, ["id", "name", "tasks"]), id, name, tasks });
  }
  return result;
}
function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
function isQuotaError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014;
}
export function getBrowserStorage(host: { localStorage?: Storage } = globalThis): Storage | null {
  try { return host.localStorage ?? null; } catch { return null; }
}
export function backupKey(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1) throw new RangeError("Backup slot must be a positive integer.");
  return slot === 1 ? BACKUP_KEY : `${BACKUP_KEY}.${slot}`;
}
export function backupMetaKey(slot: number): string { return `${backupKey(slot)}.meta`; }
export function isBackupKeyName(key: string): boolean {
  if (key === BACKUP_KEY) return true;
  const prefix = `${BACKUP_KEY}.`;
  if (!key.startsWith(prefix)) return false;
  const suffix = key.slice(prefix.length);
  return /^(?:[2-9]|1[0-9]|20)$/.test(suffix);
}
function slotFromKey(key: string): number | null {
  if (key === BACKUP_KEY) return 1;
  if (!isBackupKeyName(key)) return null;
  const n = Number(key.slice(BACKUP_KEY.length + 1));
  return Number.isInteger(n) && n >= 2 && n <= MAX_BACKUPS ? n : null;
}
type Inspection = { kind: "empty" } | { kind: "ok"; parsed: Parsed } | { kind: "recovered"; parsed: Parsed } | { kind: "invalid"; parsed: Parsed } | { kind: "corrupt" };
function inspectRaw(raw: string): Inspection {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { kind: "corrupt" }; }
  if (Array.isArray(json) && json.length === 0) return { kind: "empty" };
  const parsed = parseProjects(json);
  if (!parsed.projects.length) return { kind: "invalid", parsed };
  const lossless = !parsed.droppedProjects && !parsed.droppedTasks && !parsed.repairedProjects;
  return { kind: lossless ? "ok" : "recovered", parsed };
}
type BackupOutcome = { ok: true; key: string; created: boolean } | { ok: false; reason: string };
function writeMeta(storage: StorageLike, slot: number, reason: BackupReason): void {
  try { storage.setItem(backupMetaKey(slot), JSON.stringify({ createdAt: Date.now(), reason })); } catch { /* best effort */ }
}
function backUpRaw(storage: StorageLike, raw: string, reason: BackupReason): BackupOutcome {
  let free: number | null = null;
  try {
    for (let slot = 1; slot <= MAX_BACKUPS; slot++) {
      const key = backupKey(slot), existing = storage.getItem(key);
      if (existing === raw) return { ok: true, key, created: false };
      if (existing === null && free === null) free = slot;
    }
  } catch { return { ok: false, reason: "read-error" }; }
  if (free === null) return { ok: false, reason: "slots-full" };
  const key = backupKey(free);
  try { storage.setItem(key, raw); } catch { return { ok: false, reason: "write-failed" }; }
  try { if (storage.getItem(key) !== raw) return { ok: false, reason: "verify" }; }
  catch { return { ok: false, reason: "verify" }; }
  writeMeta(storage, free, reason);
  return { ok: true, key, created: true };
}
const emptyResult = (status: LoadStatus): LoadResult => ({
  projects: starter.map((p) => ({ ...p, tasks: [] })), status, droppedProjects: 0,
  droppedTasks: 0, repairedProjects: 0, backedUp: false, backupKey: null, storageRaw: null
});
function backupFields(outcome: BackupOutcome): Pick<LoadResult, "backedUp" | "backupKey"> {
  return outcome.ok ? { backedUp: true, backupKey: outcome.key } : { backedUp: false, backupKey: null };
}
export function readProjects(storage: ReadableStorage | null = getBrowserStorage()): LoadResult {
  if (!storage) return emptyResult("unavailable");
  let raw: string | null;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return emptyResult("unavailable"); }
  if (raw === null) return emptyResult("empty");
  const inspected = inspectRaw(raw);
  switch (inspected.kind) {
    case "empty": return { ...emptyResult("empty"), storageRaw: raw };
    case "ok": return { ...inspected.parsed, status: "ok", backedUp: false, backupKey: null, storageRaw: raw };
    case "recovered": return { ...inspected.parsed, status: "recovered", ...backupFields(backUpRaw(storage as StorageLike, raw, "recovered")), storageRaw: raw };
    case "invalid": return { ...emptyResult("invalid"), droppedProjects: inspected.parsed.droppedProjects, ...backupFields(backUpRaw(storage as StorageLike, raw, "invalid")), storageRaw: raw };
    case "corrupt": return { ...emptyResult("corrupt"), ...backupFields(backUpRaw(storage as StorageLike, raw, "corrupt")), storageRaw: raw };
  }
}
export function loadProjects(storage?: ReadableStorage | null): Project[] {
  return readProjects(storage === undefined ? getBrowserStorage() : storage).projects;
}
type Guard = { ok: true; backupKey?: string } | Extract<SaveResult, { ok: false }>;
function protectStoredOriginal(target: WritableStorage): Guard {
  if (!target.getItem) return { ok: true };
  let raw: string | null;
  try { raw = target.getItem(STORAGE_KEY); }
  catch (error) { return { ok: false, reason: "unavailable", message: `Browser storage could not be read: ${describeError(error)}` }; }
  if (raw === null) return { ok: true };
  const kind = inspectRaw(raw).kind;
  if (kind === "empty" || kind === "ok") return { ok: true };
  const reason: BackupReason = kind === "corrupt" ? "corrupt" : kind === "invalid" ? "invalid" : "recovered";
  const outcome = backUpRaw(target as StorageLike, raw, reason);
  if (outcome.ok) return { ok: true, backupKey: outcome.key };
  return { ok: false, reason: "protect-original", message: `The stored data could not be copied to a backup (${outcome.reason}); it was left untouched.` };
}
export function saveProjects(projects: Project[], storage?: WritableStorage | null, expectedRaw?: string | null): SaveResult {
  const target = storage === undefined ? getBrowserStorage() : storage;
  if (!target) return { ok: false, reason: "unavailable", message: "Browser storage is not available." };
  const checked = parseProjects(projects);
  if (checked.droppedProjects || checked.droppedTasks || checked.repairedProjects || checked.projects.length !== projects.length)
    return { ok: false, reason: "invalid-data", message: "Refused to save data that does not match the project format." };
  let serialized: string;
  try { serialized = JSON.stringify(checked.projects); }
  catch (error) { return { ok: false, reason: "serialize", message: describeError(error) }; }
  if (expectedRaw !== undefined && target.getItem) {
    let currentRaw: string | null;
    try { currentRaw = target.getItem(STORAGE_KEY); }
    catch (error) { return { ok: false, reason: "unavailable", message: `Browser storage could not be read: ${describeError(error)}` }; }
    if (currentRaw !== expectedRaw) return { ok: false, reason: "conflict", message: "The workspace changed in another tab or session. Reload the latest saved workspace before editing again." };
  }
  const guard = protectStoredOriginal(target);
  if (!guard.ok) return guard;
  try { target.setItem(STORAGE_KEY, serialized); }
  catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: "quota", message: "Browser storage is full." };
    const name = isRecord(error) ? error.name : undefined;
    if (name === "SecurityError") return { ok: false, reason: "unavailable", message: "Browser storage is blocked." };
    return { ok: false, reason: "unknown", message: describeError(error) };
  }
  if (target.getItem) {
    try { if (target.getItem(STORAGE_KEY) !== serialized) return { ok: false, reason: "verify", message: "The saved data could not be read back." }; }
    catch (error) { return { ok: false, reason: "verify", message: describeError(error) }; }
  }
  return guard.backupKey ? { ok: true, backupKey: guard.backupKey } : { ok: true };
}
type LockFailure = { ok: false; reason: "lock-unavailable" | "lock-timeout" | "lock-error"; message: string };
type LockResult<T> = { ok: true; value: T } | LockFailure;
export function hasStorageLock(): boolean {
  try { return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function"; } catch { return false; }
}
export async function withStorageLock<T>(callback: () => T | Promise<T>, options: { timeoutMs?: number } = {}): Promise<LockResult<T>> {
  if (!hasStorageLock()) return { ok: false, reason: "lock-unavailable", message: "The cross-tab lock (Web Locks) is not available in this browser." };
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = navigator.locks.request(STORAGE_LOCK_NAME, { mode: "exclusive", signal: controller.signal }, async () => {
      if (timer !== undefined) clearTimeout(timer);
      return await callback();
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error("Storage lock timed out."); error.name = "TimeoutError"; reject(error);
      }, timeoutMs);
    });
    const value = await Promise.race([work, timeout]);
    return { ok: true, value };
  } catch (error) {
    const name = isRecord(error) ? error.name : undefined;
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "lock-timeout", message: "Timed out waiting for the cross-tab storage lock." };
    return { ok: false, reason: "lock-error", message: describeError(error) };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function lockFailure(result: LockFailure): Extract<SaveResult, { ok: false }> {
  return { ok: false, reason: result.reason, message: result.message };
}
export async function saveProjectsLocked(projects: Project[], storage?: WritableStorage | null, expectedRaw?: string | null): Promise<SaveResult> {
  const locked = await withStorageLock(() => saveProjects(projects, storage, expectedRaw));
  return locked.ok ? locked.value : lockFailure(locked);
}
export async function readProjectsLocked(storage: ReadableStorage | null = getBrowserStorage()): Promise<LoadResult> {
  const locked = await withStorageLock(() => readProjects(storage));
  if (locked.ok) return locked.value;
  if (locked.reason === "lock-unavailable") {
    if (!storage) return emptyResult("unavailable");
    return readProjects({ getItem: storage.getItem.bind(storage) });
  }
  return emptyResult("unavailable");
}
export function listBackups(storage: ReadableStorage | null = getBrowserStorage()): BackupInfo[] {
  if (!storage) return [];
  const items: BackupInfo[] = [];
  for (let slot = 1; slot <= MAX_BACKUPS; slot++) {
    const key = backupKey(slot);
    let raw: string | null;
    try { raw = storage.getItem(key); } catch { break; }
    if (raw === null) continue;
    let createdAt: number | null = null, reason: BackupReason | null = null;
    try {
      const meta = JSON.parse(storage.getItem(backupMetaKey(slot)) ?? "null");
      if (isRecord(meta)) {
        if (typeof meta.createdAt === "number" && Number.isFinite(meta.createdAt)) createdAt = meta.createdAt;
        if (typeof meta.reason === "string" && BACKUP_REASONS.has(meta.reason as BackupReason)) reason = meta.reason as BackupReason;
      }
    } catch { /* legacy or unreadable metadata */ }
    let parseable = false, projectCount: number | null = null;
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) { parseable = true; projectCount = parsed.length; } } catch { /* raw backup is retained */ }
    const inspection = inspectRaw(raw);
    const restorable = inspection.kind === "ok" || inspection.kind === "empty";
    items.push({ key, slot, createdAt, reason, parseable, restorable, projectCount, preview: raw.slice(0, 180) });
  }
  return items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.slot - b.slot);
}
export type RestoreResult =
  | { ok: true; snapshotKey: string | null }
  | { ok: false; reason: "lock-unavailable" | "lock-timeout" | "lock-error" | "not-found" | "invalid-key" | "protect-original" | "write-failed" | "verify" | "invalid-backup"; message: string; snapshotKey?: string | null; rollbackVerified?: boolean };
export async function restoreBackup(key: string, storage: StorageLike | null = getBrowserStorage()): Promise<RestoreResult> {
  if (slotFromKey(key) === null) return { ok: false, reason: "invalid-key", message: "Invalid backup key." };
  const locked = await withStorageLock((): RestoreResult => {
    if (!storage) return { ok: false, reason: "write-failed", message: "Browser storage is unavailable." };
    let backup: string | null, current: string | null;
    try { backup = storage.getItem(key); current = storage.getItem(STORAGE_KEY); }
    catch (error) { return { ok: false, reason: "write-failed", message: describeError(error) }; }
    if (backup === null) return { ok: false, reason: "not-found", message: "The selected backup no longer exists." };
    // Validate the complete backup before creating a snapshot or changing the workspace.
    const inspection = inspectRaw(backup);
    if (inspection.kind !== "ok" && inspection.kind !== "empty") {
      return { ok: false, reason: "invalid-backup", message: "This backup is incomplete or invalid. The current workspace was not changed." };
    }
    const normalized = inspection.kind === "empty" ? "[]" : JSON.stringify(inspection.parsed.projects);
    let snapshotKey: string | null = null;
    if (current !== null) {
      const snapshot = backUpRaw(storage, current, "pre-restore");
      if (!snapshot.ok) return { ok: false, reason: "protect-original", message: "The current workspace could not be snapshotted; restore was cancelled." };
      snapshotKey = snapshot.key;
    }
    try { storage.setItem(STORAGE_KEY, normalized); }
    catch (error) { return { ok: false, reason: "write-failed", message: describeError(error) }; }
    let verifyError: string | null = null;
    try { if (storage.getItem(STORAGE_KEY) !== normalized) verifyError = "Restored data did not match the requested backup."; }
    catch (error) { verifyError = describeError(error); }
    if (verifyError !== null) {
      let rolledBack = false;
      try {
        if (current === null) {
          if (!storage.removeItem) throw new Error("Storage cannot remove the uncommitted restore.");
          storage.removeItem(STORAGE_KEY);
          rolledBack = storage.getItem(STORAGE_KEY) === null;
        } else {
          storage.setItem(STORAGE_KEY, current);
          rolledBack = storage.getItem(STORAGE_KEY) === current;
        }
      } catch { rolledBack = false; }
      const recovery = snapshotKey ? ` The pre-restore snapshot is retained at ${snapshotKey}.` : "";
      return { ok: false, reason: "verify", snapshotKey, rollbackVerified: rolledBack, message: rolledBack
        ? `Restore verification failed; the previous workspace was restored automatically.${recovery}`
        : `Restore verification failed and automatic rollback could not be verified. Do not edit yet; the pre-restore snapshot is at ${snapshotKey ?? "unavailable"}.` };
    }
    return { ok: true, snapshotKey };
  });
  return locked.ok ? locked.value : { ok: false, reason: locked.reason, message: locked.message };
}
export type DeleteBackupResult =
  | { ok: true }
  | { ok: false; reason: "lock-unavailable" | "lock-timeout" | "lock-error" | "not-found" | "invalid-key" | "delete-failed"; message: string };
export async function deleteBackup(key: string, storage: StorageLike | null = getBrowserStorage()): Promise<DeleteBackupResult> {
  const slot = slotFromKey(key);
  if (slot === null) return { ok: false, reason: "invalid-key", message: "Invalid backup key." };
  const locked = await withStorageLock((): DeleteBackupResult => {
    if (!storage?.removeItem) return { ok: false, reason: "delete-failed", message: "Browser storage cannot delete backups." };
    try {
      if (storage.getItem(key) === null) return { ok: false, reason: "not-found", message: "Backup not found." };
      storage.removeItem(key);
      storage.removeItem(backupMetaKey(slot));
      return storage.getItem(key) === null ? { ok: true } : { ok: false, reason: "delete-failed", message: "Backup could not be removed." };
    } catch (error) { return { ok: false, reason: "delete-failed", message: describeError(error) }; }
  });
  return locked.ok ? locked.value : { ok: false, reason: locked.reason, message: locked.message };
}
