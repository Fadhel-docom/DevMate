import { STORAGE_LOCK_NAME, withStorageLock } from "./storage";

export type DurableStoreName = "project-profiles" | "task-ledger";
export type DurableSnapshotReason = "pre-migration" | "pre-restore" | "corrupt" | "future-version";
export type DurableStoreFailure =
  | "unavailable" | "lock-unavailable" | "lock-timeout" | "lock-error"
  | "corrupt" | "future-version" | "invalid-data" | "conflict"
  | "write-failed" | "verify-failed" | "indeterminate" | "snapshot-full" | "not-found";

export type DurableEnvelope<T> = {
  schemaVersion: 1;
  revision: number;
  updatedAt: number;
  records: Record<string, T>;
};
type TransactionJournal = {
  version: 1;
  transactionId: string;
  projectId: string;
  beforeRaw: string | null;
  afterRaw: string;
  phase: "intent" | "committed" | "rolled-back" | "indeterminate";
  createdAt: number;
};
type MigrationMarker = { version: 1; migratedAt: number; sourceFingerprint: string };
export type DurableReadResult<T> =
  | { ok: true; status: "empty"; revision: number; value: null }
  | { ok: true; status: "found"; revision: number; value: T }
  | { ok: false; reason: DurableStoreFailure; message: string };
export type DurableWriteResult =
  | { ok: true; revision: number; updatedAt: number }
  | { ok: false; reason: DurableStoreFailure; message: string };
export type DurableSnapshot = {
  key: string; slot: number; createdAt: number; reason: DurableSnapshotReason;
  fingerprint: string; raw: string;
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type LockRunner = <R>(work: () => R | Promise<R>) => Promise<
  { ok: true; value: R } | { ok: false; reason: "lock-unavailable" | "lock-timeout" | "lock-error"; message: string }
>;
export type DurableStoreOptions<T> = {
  name: DurableStoreName;
  storage?: StorageLike | null;
  now?: () => number;
  createId?: () => string;
  validateRecord: (projectId: string, value: unknown) => value is T;
  validateUpdate?: (projectId: string, previous: T | null, next: T, records: Readonly<Record<string, T>>) => boolean;
  runExclusive?: LockRunner;
  maxBackups?: number;
};
const STORE_PREFIX = "devmate-durable-store-v1";
const JOURNAL_PREFIX = "devmate-durable-journal-v1";
const MIGRATION_PREFIX = "devmate-migrations-v1";
const BACKUP_PREFIX = "devmate-durable-backups-v1";
const DEFAULT_MAX_BACKUPS = 5;
const safeId = (value: string): boolean =>
  value.length > 0 && value.length <= 160 && !["__proto__", "prototype", "constructor"].includes(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fingerprint = (raw: string): string => {
  // Stable non-cryptographic fingerprint for stale-slot detection, not an integrity signature.
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const clone = <V>(value: V): V => JSON.parse(JSON.stringify(value)) as V;
function envelopeFromRaw<T>(raw: string): DurableEnvelope<T> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isObject(parsed) || parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.revision) ||
      (parsed.revision as number) < 0 || typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt) || !isObject(parsed.records)) return null;
  return parsed as unknown as DurableEnvelope<T>;
}
function lockFailure(reason: "lock-unavailable" | "lock-timeout" | "lock-error", message: string): DurableWriteResult {
  return { ok: false, reason, message };
}

export function durableStoreKey(name: DurableStoreName): string { return `${STORE_PREFIX}:${name}`; }
export function durableJournalKey(name: DurableStoreName): string { return `${JOURNAL_PREFIX}:${name}`; }
export function durableMigrationKey(name: DurableStoreName): string { return `${MIGRATION_PREFIX}:${name}`; }
export function durableBackupKey(name: DurableStoreName, slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > DEFAULT_MAX_BACKUPS) throw new RangeError("Invalid durable backup slot.");
  return `${BACKUP_PREFIX}:${name}:${slot}`;
}

export function createDurableStore<T>(options: DurableStoreOptions<T>) {
  const storage = options.storage === undefined
    ? (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })()
    : options.storage;
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => `tx-${now()}-${Math.random().toString(36).slice(2)}`);
  const maxBackups = Math.min(DEFAULT_MAX_BACKUPS, Math.max(1, options.maxBackups ?? DEFAULT_MAX_BACKUPS));
  const runExclusive: LockRunner = options.runExclusive ?? (async (work) => {
    const result = await withStorageLock(work, { timeoutMs: 8000 });
    return result;
  });
  const dataKey = durableStoreKey(options.name);
  const journalKey = durableJournalKey(options.name);
  const migrationKey = durableMigrationKey(options.name);

  const readRaw = (): string | null => {
    if (!storage) throw new Error("Browser storage is unavailable.");
    return storage.getItem(dataKey);
  };
  const writeRaw = (raw: string | null): void => {
    if (!storage) throw new Error("Browser storage is unavailable.");
    if (raw === null) storage.removeItem(dataKey);
    else storage.setItem(dataKey, raw);
  };
  const writeJournal = (journal: TransactionJournal): void => {
    if (!storage) throw new Error("Browser storage is unavailable.");
    storage.setItem(journalKey, JSON.stringify(journal));
    if (storage.getItem(journalKey) !== JSON.stringify(journal)) throw new Error("Transaction journal verification failed.");
  };
  const snapshotRaw = (raw: string, reason: DurableSnapshotReason): DurableSnapshot | null => {
    if (!storage) return null;
    for (let slot = 1; slot <= maxBackups; slot++) {
      const key = durableBackupKey(options.name, slot);
      const existing = storage.getItem(key);
      if (existing === raw) {
        const metaRaw = storage.getItem(`${key}:meta`);
        const meta = metaRaw ? JSON.parse(metaRaw) as { createdAt?: number; reason?: DurableSnapshotReason } : {};
        return { key, slot, createdAt: meta.createdAt ?? now(), reason: meta.reason ?? reason, fingerprint: fingerprint(raw), raw };
      }
      if (existing === null) {
        storage.setItem(key, raw);
        if (storage.getItem(key) !== raw) throw new Error("Snapshot verification failed.");
        const createdAt = now();
        storage.setItem(`${key}:meta`, JSON.stringify({ createdAt, reason, fingerprint: fingerprint(raw) }));
        return { key, slot, createdAt, reason, fingerprint: fingerprint(raw), raw };
      }
    }
    return null;
  };
  const recoverLocked = (): DurableWriteResult => {
    if (!storage) return { ok: false, reason: "unavailable", message: "Browser storage is unavailable." };
    let journalRaw: string | null, currentRaw: string | null;
    try { journalRaw = storage.getItem(journalKey); currentRaw = readRaw(); }
    catch (error) { return { ok: false, reason: "write-failed", message: String(error) }; }
    if (journalRaw === null) return { ok: true, revision: 0, updatedAt: now() };
    let journal: unknown;
    try { journal = JSON.parse(journalRaw); } catch {
      return { ok: false, reason: "indeterminate", message: "The transaction journal is unreadable; writes are locked pending recovery." };
    }
    if (!isObject(journal) || journal.version !== 1 || typeof journal.phase !== "string") {
      return { ok: false, reason: "indeterminate", message: "The transaction journal has an unknown shape; writes are locked pending recovery." };
    }
    if (journal.phase === "indeterminate") return { ok: false, reason: "indeterminate", message: "A previous write could not be safely reconciled; writes remain locked." };
    if (journal.phase !== "intent") return { ok: true, revision: 0, updatedAt: now() };
    const beforeRaw = journal.beforeRaw;
    const afterRaw = journal.afterRaw;
    if (!(beforeRaw === null || typeof beforeRaw === "string") || typeof afterRaw !== "string") {
      return { ok: false, reason: "indeterminate", message: "The pending transaction has invalid recovery data." };
    }
    try {
      if (currentRaw === afterRaw) {
        writeRaw(beforeRaw);
        if (readRaw() !== beforeRaw) throw new Error("Recovery rollback could not be verified.");
      } else if (currentRaw !== beforeRaw) {
        const pending = { ...journal, phase: "indeterminate" as const };
        writeJournal(pending as TransactionJournal);
        return { ok: false, reason: "indeterminate", message: "Stored data matches neither side of the pending transaction; automatic recovery was refused." };
      }
      writeJournal({ ...(journal as TransactionJournal), phase: "rolled-back" });
      return { ok: true, revision: 0, updatedAt: now() };
    } catch (error) {
      try { writeJournal({ ...(journal as TransactionJournal), phase: "indeterminate" }); } catch { /* retain original intent if journal is unavailable */ }
      return { ok: false, reason: "indeterminate", message: `Interrupted-write recovery failed: ${String(error)}` };
    }
  };
  const loadEnvelopeLocked = (): { envelope: DurableEnvelope<T> | null; failure?: DurableReadResult<T> } => {
    let raw: string | null;
    try { raw = readRaw(); } catch (error) {
      return { envelope: null, failure: { ok: false, reason: "unavailable", message: String(error) } };
    }
    if (raw === null) return { envelope: { schemaVersion: 1, revision: 0, updatedAt: now(), records: {} } };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      try { snapshotRaw(raw, "corrupt"); } catch { /* the corrupt source remains untouched */ }
      return { envelope: null, failure: { ok: false, reason: "corrupt", message: "Stored durable data is corrupt; the original bytes were preserved where a snapshot slot was available." } };
    }
    if (isObject(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > 1) {
      try { snapshotRaw(raw, "future-version"); } catch { /* preserve original bytes */ }
      return { envelope: null, failure: { ok: false, reason: "future-version", message: "Stored data was written by a newer schema version and was not modified." } };
    }
    const envelope = envelopeFromRaw<T>(raw);
    if (!envelope) {
      try { snapshotRaw(raw, "corrupt"); } catch { /* preserve original bytes */ }
      return { envelope: null, failure: { ok: false, reason: "corrupt", message: "Stored durable data failed schema validation and was not modified." } };
    }
    return { envelope };
  };
  const transactLocked = (projectId: string, nextEnvelope: DurableEnvelope<T>): DurableWriteResult => {
    if (!storage) return { ok: false, reason: "unavailable", message: "Browser storage is unavailable." };
    let beforeRaw: string | null;
    try { beforeRaw = readRaw(); } catch (error) { return { ok: false, reason: "write-failed", message: String(error) }; }
    let afterRaw: string;
    try { afterRaw = JSON.stringify(nextEnvelope); } catch (error) {
      return { ok: false, reason: "invalid-data", message: `Durable data could not be serialized: ${String(error)}` };
    }
    const journal: TransactionJournal = {
      version: 1, transactionId: createId(), projectId, beforeRaw, afterRaw, phase: "intent", createdAt: now()
    };
    try {
      writeJournal(journal);
      writeRaw(afterRaw);
      if (readRaw() !== afterRaw) throw new Error("Read-back verification failed.");
      writeJournal({ ...journal, phase: "committed" });
      return { ok: true, revision: nextEnvelope.revision, updatedAt: nextEnvelope.updatedAt };
    } catch (error) {
      try {
        writeRaw(beforeRaw);
        if (readRaw() !== beforeRaw) throw new Error("Rollback verification failed.");
        writeJournal({ ...journal, phase: "rolled-back" });
        return { ok: false, reason: "write-failed", message: `Write failed and the previous value was restored: ${String(error)}` };
      } catch (rollbackError) {
        try { writeJournal({ ...journal, phase: "indeterminate" }); } catch { /* preserve whichever journal bytes survived */ }
        return { ok: false, reason: "indeterminate", message: `Write failed and rollback could not be verified: ${String(rollbackError)}` };
      }
    }
  };

  return {
    async readProject(projectId: string): Promise<DurableReadResult<T>> {
      if (!safeId(projectId)) return { ok: false, reason: "invalid-data", message: "A valid projectId is required." };
      const locked = await runExclusive(() => {
        const recovered = recoverLocked();
        if (!recovered.ok) return { ok: false as const, reason: recovered.reason, message: recovered.message };
        const loaded = loadEnvelopeLocked();
        if (loaded.failure) return loaded.failure;
        const value = loaded.envelope!.records[projectId];
        if (value === undefined) return { ok: true as const, status: "empty" as const, revision: loaded.envelope!.revision, value: null };
        if (!options.validateRecord(projectId, value)) return { ok: false as const, reason: "corrupt" as const, message: "The project-scoped record failed its validator." };
        return { ok: true as const, status: "found" as const, revision: loaded.envelope!.revision, value: clone(value) };
      });
      if (!locked.ok) return { ok: false, reason: locked.reason, message: locked.message };
      return locked.value;
    },
    async writeProject(projectId: string, value: T, expectedRevision?: number): Promise<DurableWriteResult> {
      if (!safeId(projectId) || !options.validateRecord(projectId, value))
        return { ok: false, reason: "invalid-data", message: "The projectId or project-scoped record is invalid." };
      const locked = await runExclusive(() => {
        const recovered = recoverLocked();
        if (!recovered.ok) return recovered;
        const loaded = loadEnvelopeLocked();
        if (loaded.failure) return { ok: false as const, reason: loaded.failure.reason, message: loaded.failure.message };
        const current = loaded.envelope!;
        if (!Object.entries(current.records).every(([id, item]) => safeId(id) && options.validateRecord(id, item)))
          return { ok: false as const, reason: "corrupt" as const, message: "An existing project record failed validation; no write was attempted." };
        if (expectedRevision !== undefined && current.revision !== expectedRevision)
          return { ok: false as const, reason: "conflict" as const, message: "The durable store revision changed; reload before writing." };
        const previous = current.records[projectId] ?? null;
        if (options.validateUpdate && !options.validateUpdate(projectId, previous, value, current.records))
          return { ok: false as const, reason: "invalid-data" as const, message: "The project-scoped update violated its store contract." };
        const records = clone(current.records);
        records[projectId] = clone(value);
        const next: DurableEnvelope<T> = { schemaVersion: 1, revision: current.revision + 1, updatedAt: now(), records };
        return transactLocked(projectId, next);
      });
      return locked.ok ? locked.value : lockFailure(locked.reason, locked.message);
    },
    async createSnapshot(reason: DurableSnapshotReason): Promise<DurableSnapshot | null> {
      const locked = await runExclusive(() => {
        if (!storage) return null;
        const raw = readRaw();
        if (raw === null) return null;
        return snapshotRaw(raw, reason);
      });
      if (!locked.ok) return null;
      return locked.value;
    },
    async listSnapshots(): Promise<DurableSnapshot[]> {
      const locked = await runExclusive(() => {
        if (!storage) return [];
        const snapshots: DurableSnapshot[] = [];
        for (let slot = 1; slot <= maxBackups; slot++) {
          const key = durableBackupKey(options.name, slot);
          const raw = storage.getItem(key);
          if (raw === null) continue;
          let meta: { createdAt?: number; reason?: DurableSnapshotReason } = {};
          try { meta = JSON.parse(storage.getItem(`${key}:meta`) ?? "{}") as typeof meta; } catch { /* raw backup remains exportable */ }
          snapshots.push({ key, slot, createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
            reason: meta.reason ?? "corrupt", fingerprint: fingerprint(raw), raw });
        }
        return snapshots.sort((a, b) => b.createdAt - a.createdAt || a.slot - b.slot);
      });
      return locked.ok ? locked.value : [];
    },
    async restoreSnapshot(projectId: string, key: string, expectedFingerprint: string): Promise<DurableWriteResult> {
      if (!safeId(projectId)) return { ok: false, reason: "invalid-data", message: "A valid projectId is required." };
      const allowed = Array.from({ length: maxBackups }, (_, index) => durableBackupKey(options.name, index + 1));
      if (!allowed.includes(key)) return { ok: false, reason: "not-found", message: "Snapshot key is not part of this store." };
      const locked = await runExclusive(() => {
        if (!storage) return { ok: false as const, reason: "unavailable" as const, message: "Browser storage is unavailable." };
        const raw = storage.getItem(key);
        if (raw === null) return { ok: false as const, reason: "not-found" as const, message: "Snapshot not found." };
        if (fingerprint(raw) !== expectedFingerprint) return { ok: false as const, reason: "conflict" as const, message: "Snapshot content changed; refresh the snapshot list." };
        const currentRaw = readRaw();
        const currentEnvelope = currentRaw === null
          ? { schemaVersion: 1 as const, revision: 0, updatedAt: now(), records: {} as Record<string, T> }
          : envelopeFromRaw<T>(currentRaw);
        const restored = envelopeFromRaw<T>(raw);
        if (!options.validateUpdate)
          return { ok: false as const, reason: "invalid-data" as const, message: "Restore requires the store-specific update guard; an unguarded restore is refused." };
        if (!currentEnvelope || !restored ||
          !Object.entries(currentEnvelope.records).every(([id, item]) => safeId(id) && options.validateRecord(id, item)))
          return { ok: false as const, reason: "corrupt" as const, message: "Current data failed validation; restore was refused without changing it." };
        const nextRecord = restored.records[projectId];
        if (nextRecord === undefined || !options.validateRecord(projectId, nextRecord))
          return { ok: false as const, reason: "not-found" as const, message: "The selected snapshot has no valid record for this project." };
        const previous = currentEnvelope.records[projectId] ?? null;
        if (!options.validateUpdate(projectId, previous, nextRecord, currentEnvelope.records))
          return { ok: false as const, reason: "invalid-data" as const, message: "The project-specific update guard rejected this restore." };
        if (currentRaw !== null) {
          try { if (!snapshotRaw(currentRaw, "pre-restore")) return { ok: false as const, reason: "snapshot-full" as const, message: "No free snapshot slot; restore was cancelled." }; }
          catch (error) { return { ok: false as const, reason: "write-failed" as const, message: String(error) }; }
        }
        const records = clone(currentEnvelope.records);
        records[projectId] = clone(nextRecord);
        const next: DurableEnvelope<T> = { schemaVersion: 1, revision: currentEnvelope.revision + 1, updatedAt: now(), records };
        return transactLocked(projectId, next);
      });
      return locked.ok ? locked.value : lockFailure(locked.reason, locked.message);
    },
    async migrationStatus(): Promise<"never-migrated" | "migrated" | "unreadable"> {
      const locked = await runExclusive(() => {
        if (!storage) return "unreadable" as const;
        try {
          const raw = storage.getItem(migrationKey);
          if (raw === null) return "never-migrated" as const;
          const marker = JSON.parse(raw) as MigrationMarker;
          return marker.version === 1 && typeof marker.sourceFingerprint === "string" ? "migrated" as const : "unreadable" as const;
        } catch { return "unreadable" as const; }
      });
      return locked.ok ? locked.value : "unreadable";
    },
    async markMigrated(sourceRaw: string): Promise<boolean> {
      const locked = await runExclusive(() => {
        if (!storage) return false;
        try {
          const existing = storage.getItem(migrationKey);
          if (existing !== null) return false;
          if (!snapshotRaw(sourceRaw, "pre-migration")) return false;
          const marker: MigrationMarker = { version: 1, migratedAt: now(), sourceFingerprint: fingerprint(sourceRaw) };
          storage.setItem(migrationKey, JSON.stringify(marker));
          return storage.getItem(migrationKey) === JSON.stringify(marker);
        } catch { return false; }
      });
      return locked.ok && locked.value;
    },
    async recover(): Promise<DurableWriteResult> {
      const locked = await runExclusive(recoverLocked);
      return locked.ok ? locked.value : lockFailure(locked.reason, locked.message);
    },
    keys: { data: dataKey, journal: journalKey, migration: migrationKey, lock: STORAGE_LOCK_NAME }
  };
}
