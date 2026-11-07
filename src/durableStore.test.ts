import { describe, expect, it } from "vitest";
import {
  createDurableStore,
  durableBackupKey,
  durableJournalKey,
  durableStoreKey,
  type DurableEnvelope
} from "./durableStore";

type RecordValue = { projectId: string; value: string };
class MemoryStorage {
  private values = new Map<string, string>();
  failDataWrites = 0;
  wrongReadBack = false;
  wrongReadBackOnNextDataWrite = false;
  getItem(key: string): string | null {
    if (this.wrongReadBack && key === durableStoreKey("project-profiles")) {
      this.wrongReadBack = false;
      return "wrong-read-back";
    }
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (key === durableStoreKey("project-profiles") && this.failDataWrites > 0) {
      this.failDataWrites--;
      throw new Error("injected write failure");
    }
    this.values.set(key, value);
    if (key === durableStoreKey("project-profiles") && this.wrongReadBackOnNextDataWrite) {
      this.wrongReadBackOnNextDataWrite = false;
      this.wrongReadBack = true;
    }
  }
  removeItem(key: string): void { this.values.delete(key); }
  seed(key: string, value: string): void { this.values.set(key, value); }
}
function setup(storage = new MemoryStorage()) {
  let time = 1000, id = 0;
  const store = createDurableStore<RecordValue>({
    name: "project-profiles",
    storage,
    now: () => ++time,
    createId: () => `tx-${++id}`,
    runExclusive: async (work) => ({ ok: true, value: await work() }),
    validateRecord: (projectId, value): value is RecordValue =>
      typeof value === "object" && value !== null &&
      (value as RecordValue).projectId === projectId &&
      typeof (value as RecordValue).value === "string",
    validateUpdate: () => true
  });
  return { storage, store };
}
const envelope = (records: Record<string, RecordValue>, revision = 1): string =>
  JSON.stringify({ schemaVersion: 1, revision, updatedAt: 1000, records });

describe("durable store foundation", () => {
  it("reads an empty project and writes then reads a detached project-scoped value", async () => {
    const { store } = setup();
    expect(await store.readProject("p1")).toMatchObject({ ok: true, status: "empty", revision: 0 });
    expect(await store.writeProject("p1", { projectId: "p1", value: "one" }, 0)).toMatchObject({ ok: true, revision: 1 });
    const read = await store.readProject("p1");
    expect(read).toMatchObject({ ok: true, status: "found", revision: 1, value: { projectId: "p1", value: "one" } });
    if (read.ok && read.status === "found") read.value.value = "mutated";
    expect(await store.readProject("p1")).toMatchObject({ ok: true, status: "found", value: { value: "one" } });
  });

  it("keeps records isolated by projectId and refuses a cross-project payload", async () => {
    const { store } = setup();
    expect(await store.writeProject("p1", { projectId: "p2", value: "wrong" })).toMatchObject({ ok: false, reason: "invalid-data" });
    await store.writeProject("p1", { projectId: "p1", value: "one" });
    await store.writeProject("p2", { projectId: "p2", value: "two" });
    expect(await store.readProject("p1")).toMatchObject({ ok: true, value: { value: "one" } });
    expect(await store.readProject("p2")).toMatchObject({ ok: true, value: { value: "two" } });
  });

  it("rejects stale expected revisions without writing", async () => {
    const { store, storage } = setup();
    await store.writeProject("p1", { projectId: "p1", value: "one" });
    const before = storage.getItem(durableStoreKey("project-profiles"));
    expect(await store.writeProject("p1", { projectId: "p1", value: "two" }, 0)).toMatchObject({ ok: false, reason: "conflict" });
    expect(storage.getItem(durableStoreKey("project-profiles"))).toBe(before);
  });

  it("applies the store-specific update guard inside the serialized write", async () => {
    const storage = new MemoryStorage();
    const store = createDurableStore<RecordValue>({
      name: "project-profiles", storage,
      runExclusive: async (work) => ({ ok: true, value: await work() }),
      validateRecord: (id, value): value is RecordValue => !!value && typeof value === "object" && (value as RecordValue).projectId === id,
      validateUpdate: (_id, previous, next) => previous === null || previous.value === next.value
    });
    await store.writeProject("p1", { projectId: "p1", value: "one" });
    expect(await store.writeProject("p1", { projectId: "p1", value: "changed" })).toMatchObject({ ok: false, reason: "invalid-data" });
  });

  it("rolls back and verifies the old bytes when a write cannot be read back", async () => {
    const { store, storage } = setup();
    await store.writeProject("p1", { projectId: "p1", value: "before" });
    const before = storage.getItem(durableStoreKey("project-profiles"));
    storage.wrongReadBackOnNextDataWrite = true;
    expect(await store.writeProject("p1", { projectId: "p1", value: "after" })).toMatchObject({ ok: false, reason: "write-failed" });
    expect(storage.getItem(durableStoreKey("project-profiles"))).toBe(before);
    expect(await store.readProject("p1")).toMatchObject({ ok: true, value: { value: "before" } });
  });

  it("locks writes after rollback itself cannot be verified", async () => {
    const { store, storage } = setup();
    await store.writeProject("p1", { projectId: "p1", value: "before" });
    storage.failDataWrites = 2;
    expect(await store.writeProject("p1", { projectId: "p1", value: "after" })).toMatchObject({ ok: false, reason: "indeterminate" });
    expect(await store.recover()).toMatchObject({ ok: false, reason: "indeterminate" });
    expect(await store.writeProject("p1", { projectId: "p1", value: "later" })).toMatchObject({ ok: false, reason: "indeterminate" });
  });

  it("rolls back a crash-interrupted intent when the new bytes are present", async () => {
    const { store, storage } = setup();
    const before = envelope({ p1: { projectId: "p1", value: "before" } });
    const after = envelope({ p1: { projectId: "p1", value: "after" } }, 2);
    storage.seed(durableStoreKey("project-profiles"), after);
    storage.seed(durableJournalKey("project-profiles"), JSON.stringify({
      version: 1, transactionId: "crashed", projectId: "p1",
      beforeRaw: before, afterRaw: after, phase: "intent", createdAt: 1000
    }));
    expect(await store.recover()).toMatchObject({ ok: true });
    expect(storage.getItem(durableStoreKey("project-profiles"))).toBe(before);
    expect(await store.readProject("p1")).toMatchObject({ ok: true, value: { value: "before" } });
  });

  it("fails closed when a terminal journal no longer matches the stored bytes", async () => {
    const { store, storage } = setup();
    const before = envelope({ p1: { projectId: "p1", value: "before" } });
    const after = envelope({ p1: { projectId: "p1", value: "after" } }, 2);
    storage.seed(durableStoreKey("project-profiles"), before);
    storage.seed(durableJournalKey("project-profiles"), JSON.stringify({
      version: 1, transactionId: "tampered", projectId: "p1",
      beforeRaw: before, afterRaw: after, phase: "committed", createdAt: 1000
    }));
    expect(await store.recover()).toMatchObject({ ok: false, reason: "indeterminate" });
    expect(await store.writeProject("p1", { projectId: "p1", value: "new" })).toMatchObject({ ok: false, reason: "indeterminate" });
    expect(storage.getItem(durableStoreKey("project-profiles"))).toBe(before);
  });

  it("snapshots only into the separate bounded backup namespace and refuses a sixth copy", async () => {
    const { store, storage } = setup();
    for (let i = 0; i < 5; i++) {
      const raw = envelope({ p1: { projectId: "p1", value: String(i) } }, i + 1);
      storage.seed(durableStoreKey("project-profiles"), raw);
      expect(await store.createSnapshot("corrupt")).not.toBeNull();
    }
    storage.seed(durableStoreKey("project-profiles"), envelope({ p1: { projectId: "p1", value: "six" } }, 6));
    expect(await store.createSnapshot("pre-restore")).toBeNull();
    expect(storage.getItem(durableStoreKey("project-profiles"))).not.toBeNull();
    expect(storage.getItem(durableBackupKey("project-profiles", 1))).not.toBeNull();
  });

  it("distinguishes never-migrated from migrated and requires a pre-migration snapshot", async () => {
    const { store, storage } = setup();
    expect(await store.migrationStatus()).toBe("never-migrated");
    const legacy = '[{"id":"legacy"}]';
    expect(await store.markMigrated(legacy)).toBe(false);
    await store.writeProject("p1", { projectId: "p1", value: "migrated" });
    expect(await store.markMigrated(legacy)).toBe(true);
    expect(await store.migrationStatus()).toBe("migrated");
    expect(storage.getItem(durableBackupKey("project-profiles", 1))).toBe(legacy);
    expect(await store.markMigrated(legacy)).toBe(false);
  });

  it("refuses snapshot restoration when no store-specific update guard is configured", async () => {
    const storage = new MemoryStorage();
    const store = createDurableStore<RecordValue>({
      name: "project-profiles", storage,
      runExclusive: async (work) => ({ ok: true, value: await work() }),
      validateRecord: (projectId, value): value is RecordValue =>
        !!value && typeof value === "object" && (value as RecordValue).projectId === projectId
    });
    await store.writeProject("p1", { projectId: "p1", value: "before" });
    const snapshot = await store.createSnapshot("pre-restore");
    await store.writeProject("p1", { projectId: "p1", value: "current" });
    const result = await store.restoreSnapshot("p1", snapshot!.key, snapshot!.fingerprint);
    expect(result).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.readProject("p1")).toMatchObject({ ok: true, value: { value: "current" } });
  });

  it("snapshots the current value before restoring and verifies the restored envelope", async () => {
    const { store, storage } = setup();
    await store.writeProject("p1", { projectId: "p1", value: "original" });
    const snap = await store.createSnapshot("pre-migration");
    expect(snap).not.toBeNull();
    await store.writeProject("p1", { projectId: "p1", value: "changed" });
    await store.writeProject("p2", { projectId: "p2", value: "keep" });
    const result = await store.restoreSnapshot("p1", snap!.key, snap!.fingerprint);
    expect(result.ok).toBe(true);
    expect(await store.readProject("p1")).toMatchObject({ ok: true, value: { value: "original" } });
    expect(await store.readProject("p2")).toMatchObject({ ok: true, value: { value: "keep" } });
    expect((await store.listSnapshots()).length).toBeGreaterThanOrEqual(2);
    expect(storage.getItem(durableStoreKey("project-profiles"))).not.toBeNull();
  });

  it("snapshots a structurally valid envelope when its project record fails validation", async () => {
    const { store, storage } = setup();
    const raw = envelope({ p1: { projectId: "another-project", value: "invalid" } });
    storage.seed(durableStoreKey("project-profiles"), raw);
    expect(await store.readProject("p1")).toMatchObject({ ok: false, reason: "corrupt" });
    expect(storage.getItem(durableStoreKey("project-profiles"))).toBe(raw);
    expect(storage.getItem(durableBackupKey("project-profiles", 1))).toBe(raw);
  });

  it("preserves corrupt and future-version bytes rather than overwriting them", async () => {
    const { store, storage } = setup();
    storage.seed(durableStoreKey("project-profiles"), "{broken");
    expect(await store.readProject("p1")).toMatchObject({ ok: false, reason: "corrupt" });
    expect(storage.getItem(durableStoreKey("project-profiles"))).toBe("{broken");
    expect(storage.getItem(durableBackupKey("project-profiles", 1))).toBe("{broken");
    const future = JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: 1, records: {} });
    storage.seed(durableStoreKey("project-profiles"), future);
    expect(await store.readProject("p1")).toMatchObject({ ok: false, reason: "future-version" });
    expect(storage.getItem(durableStoreKey("project-profiles"))).toBe(future);
  });
});
