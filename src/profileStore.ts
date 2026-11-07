import {
  createDurableStore,
  type DurableReadResult,
  type DurableSnapshot,
  type DurableSnapshotReason,
  type DurableStoreOptions,
  type DurableWriteResult
} from "./durableStore";
import {
  migrateLegacyProjectsToProfiles,
  validateProjectProfilesStore,
  validateProjectProfilesStoreUpdate,
  type ProjectProfile,
  type ProjectProfilesStore
} from "./projectProfiles";

export type ProfileStoreOptions = Pick<
  DurableStoreOptions<ProjectProfile>,
  "storage" | "now" | "createId" | "runExclusive" | "maxBackups"
>;

function asProjectProfilesStore(records: Readonly<Record<string, ProjectProfile>>, revision: number): ProjectProfilesStore {
  const values = Object.values(records);
  return {
    schemaVersion: 1,
    revision: Math.max(1, revision),
    updatedAt: values.reduce((latest, profile) => Math.max(latest, profile.updatedAt), 0),
    records: values
  };
}

function isProfileForProject(projectId: string, value: unknown): value is ProjectProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const profile = value as ProjectProfile;
  if (profile.projectId !== projectId) return false;
  return validateProjectProfilesStore({
    schemaVersion: 1,
    revision: 1,
    updatedAt: profile.updatedAt,
    records: [profile]
  }).ok;
}

/**
 * Project-scoped durable profile persistence.
 *
 * Every mutation is checked against the complete before/after profile maps
 * inside the shared durable-store lock. The expected durable revision is
 * mandatory at this adapter boundary to prevent stale callers overwriting
 * newer project data.
 */
export function createProjectProfileStore(options: ProfileStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const durable = createDurableStore<ProjectProfile>({
    name: "project-profiles",
    ...options,
    validateRecord: isProfileForProject,
    validateUpdate: (_projectId, _previous, _next, previousRecords, nextRecords) =>
      validateProjectProfilesStoreUpdate(
        asProjectProfilesStore(previousRecords, 1),
        asProjectProfilesStore(nextRecords, 2)
      )
  });

  return {
    readProfile(projectId: string): Promise<DurableReadResult<ProjectProfile>> {
      return durable.readProject(projectId);
    },

    writeProfile(projectId: string, profile: ProjectProfile, expectedRevision: number): Promise<DurableWriteResult> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return Promise.resolve({
          ok: false,
          reason: "invalid-data",
          message: "A non-negative durable-store revision is required."
        });
      }
      if (profile.projectId !== projectId || !isProfileForProject(projectId, profile)) {
        return Promise.resolve({
          ok: false,
          reason: "invalid-data",
          message: "The profile must be valid and its projectId must match the requested project."
        });
      }
      return durable.writeProject(projectId, profile, expectedRevision);
    },

    async migrateLegacyProfiles(): Promise<DurableWriteResult> {
      return durable.migrateLegacyWorkspace((legacyRaw, currentRecords) => {
        let legacyProjects: unknown[] = [];
        if (legacyRaw !== null) {
          const parsed: unknown = JSON.parse(legacyRaw);
          if (!Array.isArray(parsed)) {
            throw new TypeError("Legacy workspace must be a project array; migration refused without changing it.");
          }
          legacyProjects = parsed;
        }
        const existing = asProjectProfilesStore(currentRecords, 1);
        const migrated = migrateLegacyProjectsToProfiles(legacyProjects, now(), existing);
        if (migrated.rejected.length > 0) {
          throw new TypeError(
            `Legacy migration rejected ${migrated.rejected.length} project entr(y/ies); refusing a partial migration.`
          );
        }
        return Object.fromEntries(migrated.store.records.map((profile) => [profile.projectId, profile]));
      });
    },

    migrationStatus: durable.migrationStatus,
    recover: durable.recover,
    listSnapshots: durable.listSnapshots,
    createSnapshot(reason: DurableSnapshotReason): Promise<DurableSnapshot | null> {
      return durable.createSnapshot(reason);
    },
    restoreSnapshot(projectId: string, key: string, fingerprint: string): Promise<DurableWriteResult> {
      return durable.restoreSnapshot(projectId, key, fingerprint);
    }
  };
}
