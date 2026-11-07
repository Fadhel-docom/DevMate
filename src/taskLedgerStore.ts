import {
  createDurableStore,
  durableStoreKey,
  type DurableReadResult,
  type DurableSnapshot,
  type DurableSnapshotReason,
  type DurableStoreOptions,
  type DurableWriteResult
} from "./durableStore";
import {
  validateProjectProfilesStore,
  type ProjectProfilesStore
} from "./projectProfiles";
import {
  validateAppendOnlyLedgerUpdate,
  validateTaskLedgerStore,
  type TaskLedgerStore
} from "./taskLedger";

export type TaskLedgerStoreOptions = Pick<
  DurableStoreOptions<TaskLedgerStore>,
  "storage" | "now" | "createId" | "runExclusive" | "maxBackups"
>;

function isLedgerForProject(projectId: string, value: unknown): value is TaskLedgerStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ledger = value as TaskLedgerStore;
  return ledger.records.every((task) => task.projectId === projectId) &&
    ledger.events.every((event) => event.projectId === projectId) &&
    validateTaskLedgerStore(ledger).ok;
}

function readCurrentProfiles(readStorage: Pick<Storage, "getItem">): ProjectProfilesStore | null {
  let raw: string | null;
  try {
    raw = readStorage.getItem(durableStoreKey("project-profiles"));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = parsed as { schemaVersion?: unknown; revision?: unknown; updatedAt?: unknown; records?: unknown };
    if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.revision) ||
      typeof envelope.updatedAt !== "number" || !Number.isFinite(envelope.updatedAt) ||
      typeof envelope.records !== "object" || envelope.records === null || Array.isArray(envelope.records)) return null;
    const records = Object.values(envelope.records as Record<string, unknown>);
    const profiles: ProjectProfilesStore = {
      schemaVersion: 1,
      revision: envelope.revision as number,
      updatedAt: envelope.updatedAt,
      records: records as ProjectProfilesStore["records"]
    };
    return validateProjectProfilesStore(profiles).ok ? profiles : null;
  } catch {
    return null;
  }
}

/**
 * Project-scoped durable task-ledger persistence.
 *
 * Each project has an independent ledger partition. Every write requires the
 * current durable-store revision and validates the full project ledger,
 * current profile relationship, and append-only event history inside the
 * shared durable-store lock. This adapter deliberately exposes no migration
 * operation: legacy workspace tasks lack the policy and evidence fields
 * required for safe reconstruction.
 */
export function createTaskLedgerStore(options: TaskLedgerStoreOptions = {}) {
  const durable = createDurableStore<TaskLedgerStore>({
    name: "task-ledger",
    ...options,
    validateRecord: isLedgerForProject,
    validateUpdate: (projectId, previous, next, _previousRecords, _nextRecords, readStorage) => {
      if (!isLedgerForProject(projectId, next)) return false;
      const profiles = readCurrentProfiles(readStorage);
      if (!profiles || !profiles.records.some((profile) => profile.projectId === projectId)) return false;
      if (!validateTaskLedgerStore(next, profiles).ok) return false;
      if (previous === null) {
        // The domain validator requires a positive revision. A new project
        // ledger starts from an empty revision-1 baseline and appends to it.
        if (next.revision < 2) return false;
        const empty: TaskLedgerStore = {
          schemaVersion: 1,
          revision: next.revision - 1,
          updatedAt: 0,
          records: [],
          events: []
        };
        return validateAppendOnlyLedgerUpdate(empty, next, profiles);
      }
      return validateAppendOnlyLedgerUpdate(previous, next, profiles);
    }
  });

  return {
    async readLedger(projectId: string): Promise<DurableReadResult<TaskLedgerStore>> {
      const result = await durable.readProject(projectId);
      if (!result.ok || result.status === "empty") return result;
      if (!isLedgerForProject(projectId, result.value))
        return { ok: false, reason: "corrupt", message: "The stored ledger does not match its project partition." };
      const profiles = readCurrentProfiles({
        getItem: (key: string) => {
          try {
            const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
            return storage?.getItem(key) ?? null;
          } catch {
            return null;
          }
        }
      });
      if (!profiles || !profiles.records.some((profile) => profile.projectId === projectId) ||
        !validateTaskLedgerStore(result.value, profiles).ok)
        return { ok: false, reason: "invalid-data", message: "The ledger cannot be validated against the current project profiles." };
      return result;
    },

    writeLedger(projectId: string, ledger: TaskLedgerStore, expectedRevision: number): Promise<DurableWriteResult> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        return Promise.resolve({ ok: false, reason: "invalid-data", message: "A non-negative durable-store revision is required." });
      if (!isLedgerForProject(projectId, ledger))
        return Promise.resolve({ ok: false, reason: "invalid-data", message: "The ledger must be valid and contain only records for the requested project." });
      return durable.writeProject(projectId, ledger, expectedRevision);
    },

    migrationStatus: durable.migrationStatus,
    recover: durable.recover,
    listSnapshots: durable.listSnapshots,
    createSnapshot(reason: DurableSnapshotReason): Promise<DurableSnapshot | null> {
      return durable.createSnapshot(reason);
    }
  };
}
