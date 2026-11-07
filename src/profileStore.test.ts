import { describe, expect, it } from "vitest";
import { createProjectProfileStore } from "./profileStore";
import { computeProfileContentHash, migrateLegacyProjectsToProfiles, type ProjectProfile } from "./projectProfiles";
import { STORAGE_KEY } from "./storage";
import type { ProfileStoreOptions } from "./profileStore";

class MemoryStorage {
  private values = new Map<string, string>();
  failMigrationMarkerWrites = 0;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (key === "devmate-migrations-v1:project-profiles" && this.failMigrationMarkerWrites > 0) {
      this.failMigrationMarkerWrites--;
      throw new Error("injected marker write failure");
    }
    this.values.set(key, value);
  }
  removeItem(key: string): void { this.values.delete(key); }
  seed(key: string, value: string): void { this.values.set(key, value); }
}

const runExclusive: NonNullable<ProfileStoreOptions["runExclusive"]> = async (work) => ({
  ok: true,
  value: await work()
});

function draftProfile(projectId: string, name: string, at = 100): ProjectProfile {
  return migrateLegacyProjectsToProfiles([{ id: projectId, name }], at).store.records[0];
}

function makeStore(storage = new MemoryStorage(), now = 200) {
  const store = createProjectProfileStore({ storage, now: () => now, runExclusive });
  return { store, storage };
}

describe("durable project profile adapter", () => {
  it("writes and reads a project-scoped profile with mandatory revision checks", async () => {
    const { store } = makeStore();
    const profile = draftProfile("p1", "One");
    const written = await store.writeProfile("p1", profile, 0);
    expect(written).toMatchObject({ ok: true, revision: 1 });
    expect(await store.readProfile("p1")).toMatchObject({ ok: true, status: "found", value: profile });
    expect(await store.writeProfile("p1", profile, 0)).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("does not expose another project's profile through a project-scoped read", async () => {
    const { store } = makeStore();
    expect((await store.writeProfile("p1", draftProfile("p1", "One"), 0)).ok).toBe(true);
    expect(await store.readProfile("p2")).toMatchObject({ ok: true, status: "empty", value: null });
  });

  it("rejects mismatched project IDs and malformed approval-bound content", async () => {
    const { store } = makeStore();
    expect(await store.writeProfile("p1", draftProfile("p2", "Two"), 0))
      .toMatchObject({ ok: false, reason: "invalid-data" });
    const invalid = draftProfile("p1", "One");
    invalid.approval.status = "approved";
    expect(await store.writeProfile("p1", invalid, 0))
      .toMatchObject({ ok: false, reason: "invalid-data" });
  });

  it("migrates legacy projects additively and idempotently without rewriting the legacy key", async () => {
    const { store, storage } = makeStore();
    const legacy = JSON.stringify([{ id: "p1", name: "One", tasks: [] }, { id: "p2", name: "Two", tasks: [] }]);
    storage.seed(STORAGE_KEY, legacy);
    expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: true, revision: 1 });
    expect(await store.migrationStatus()).toBe("migrated");
    const legacySnapshot = (await store.listSnapshots()).find((snapshot) => snapshot.reason === "pre-migration");
    expect(legacySnapshot).toBeDefined();
    expect(await store.restoreSnapshot("p1", legacySnapshot!.key, legacySnapshot!.fingerprint, 1))
      .toMatchObject({ ok: false, reason: "invalid-data" });
    expect(storage.getItem(STORAGE_KEY)).toBe(legacy);
    expect((await store.readProfile("p1")).ok).toBe(true);
    expect((await store.readProfile("p2")).ok).toBe(true);
    expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: true, revision: 1 });
    expect(storage.getItem(STORAGE_KEY)).toBe(legacy);
  });

  it.each([["missing legacy key", null], ["empty legacy array", "[]"]])(
    "writes an empty durable envelope and retries idempotently for %s",
    async (_label, legacy) => {
      const { store, storage } = makeStore();
      if (legacy !== null) storage.seed(STORAGE_KEY, legacy);
      expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: true, revision: 1 });
      expect(storage.getItem("devmate-durable-store-v1:project-profiles")).not.toBeNull();
      expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: true, revision: 1 });
      expect(await store.migrationStatus()).toBe("migrated");
    }
  );

  it("refuses partial migration when any legacy project is invalid", async () => {
    const { store, storage } = makeStore();
    const legacy = JSON.stringify([{ id: "p1", name: "One" }, { id: "__proto__", name: "Unsafe" }]);
    storage.seed(STORAGE_KEY, legacy);
    expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.migrationStatus()).toBe("never-migrated");
    expect((await store.listSnapshots()).filter((snapshot) => snapshot.reason === "pre-migration")).toHaveLength(0);
    expect(storage.getItem(STORAGE_KEY)).toBe(legacy);
    expect(await store.readProfile("p1")).toMatchObject({ ok: true, status: "empty" });
  });

  it("refuses a non-array legacy workspace without altering the source", async () => {
    const { store, storage } = makeStore();
    storage.seed(STORAGE_KEY, JSON.stringify({ projects: [] }));
    expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ projects: [] }));
    expect(await store.migrationStatus()).toBe("never-migrated");
  });

  it("returns invalid-data rather than throwing synchronously for a null runtime payload", async () => {
    const { store } = makeStore();
    const result = await store.writeProfile("p1", null as unknown as ProjectProfile, 0);
    expect(result).toMatchObject({ ok: false, reason: "invalid-data" });
  });

  it("rejects invalid expected revisions for profile writes and restores", async () => {
    const { store } = makeStore();
    const profile = draftProfile("p1", "One");
    expect(await store.writeProfile("p1", profile, -1)).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.writeProfile("p1", profile, Number.NaN)).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.restoreSnapshot("p1", "not-a-snapshot", "00000000", -1))
      .toMatchObject({ ok: false, reason: "invalid-data" });
  });

  it("preserves existing durable profiles when migrating additional legacy projects", async () => {
    const { store, storage } = makeStore();
    const existing = draftProfile("p1", "Existing");
    storage.seed("devmate-durable-store-v1:project-profiles", JSON.stringify({
      schemaVersion: 1, revision: 4, updatedAt: existing.updatedAt, records: { p1: existing }
    }));
    const legacy = JSON.stringify([{ id: "p1", name: "Legacy replacement" }, { id: "p2", name: "New project" }]);
    storage.seed(STORAGE_KEY, legacy);
    expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: true, revision: 5 });
    expect(await store.readProfile("p1")).toMatchObject({ ok: true, value: { identity: { name: "Existing" } } });
    expect(await store.readProfile("p2")).toMatchObject({ ok: true, value: { identity: { name: "New project" } } });
  });

  it("uses the expected durable revision as a compare-and-swap guard for restore", async () => {
    const { store } = makeStore();
    const profile = draftProfile("p1", "One");
    await store.writeProfile("p1", profile, 0);
    const snapshot = await store.createSnapshot("pre-restore");
    await store.writeProfile("p1", { ...profile, profileRevision: 2, updatedAt: 201, identity: { name: "Changed", purpose: "" } }, 1);
    expect(await store.restoreSnapshot("p1", snapshot!.key, snapshot!.fingerprint, 1))
      .toMatchObject({ ok: false, reason: "conflict" });
  });

  it("retries safely after the durable data commit when writing the migration marker fails", async () => {
    const storage = new MemoryStorage();
    const { store } = makeStore(storage);
    const legacy = JSON.stringify([{ id: "p1", name: "One" }]);
    storage.seed(STORAGE_KEY, legacy);
    storage.failMigrationMarkerWrites = 1;
    expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: false, reason: "write-failed" });
    const committed = storage.getItem("devmate-durable-store-v1:project-profiles");
    expect(committed).not.toBeNull();
    expect(await store.migrateLegacyProfiles()).toMatchObject({ ok: true, revision: 1 });
    expect(storage.getItem("devmate-durable-store-v1:project-profiles")).toBe(committed);
    expect(await store.readProfile("p1")).toMatchObject({ ok: true, status: "found" });
  });

  it("runs approval-history validation inside the locked write and rejects approval regression", async () => {
    const { store } = makeStore();
    const draft = draftProfile("p1", "One");
    await store.writeProfile("p1", draft, 0);
    const approved: ProjectProfile = {
      ...draft,
      updatedAt: 201,
      approval: {
        status: "approved", approvedRevision: draft.profileRevision,
        evidence: { kind: "owner-decision", reference: "test approval", commitSha: null },
        approvedAt: 150, approvedContentHash: computeProfileContentHash(draft),
        revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: []
      }
    };
    expect(await store.writeProfile("p1", approved, 1)).toMatchObject({ ok: true, revision: 2 });
    const regression: ProjectProfile = {
      ...approved,
      profileRevision: 2,
      updatedAt: 202,
      approval: {
        status: "unapproved", approvedRevision: null, evidence: null, approvedAt: null,
        approvedContentHash: null, revokedAt: null, revokedRevision: null, revocationReason: null,
        revocationHistory: []
      }
    };
    expect(await store.writeProfile("p1", regression, 2)).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.readProfile("p1")).toMatchObject({ ok: true, value: { approval: { status: "approved" } } });
  });

  it("keeps reads available but fails writes closed when another stored profile is invalid", async () => {
    const { store, storage } = makeStore();
    const valid = draftProfile("p1", "One");
    const invalid = { ...draftProfile("p2", "Two"), projectId: "wrong-id" };
    storage.seed("devmate-durable-store-v1:project-profiles", JSON.stringify({
      schemaVersion: 1, revision: 7, updatedAt: valid.updatedAt, records: { p1: valid, p2: invalid }
    }));
    expect(await store.readProfile("p1")).toMatchObject({ ok: true, status: "found" });
    expect(await store.writeProfile("p1", { ...valid, profileRevision: 2, updatedAt: 201 }, 7))
      .toMatchObject({ ok: false, reason: "corrupt" });
    expect(await store.readProfile("p1")).toMatchObject({ ok: true, status: "found" });
  });
});
