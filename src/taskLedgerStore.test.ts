import { describe, expect, it } from "vitest";
import { createTaskLedgerStore, type TaskLedgerStoreOptions } from "./taskLedgerStore";
import { durableStoreKey } from "./durableStore";
import { migrateLegacyProjectsToProfiles, type ProjectProfilesStore } from "./projectProfiles";
import type { TaskLedgerStore } from "./taskLedger";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  seed(key: string, value: string): void { this.values.set(key, value); }
}
const runExclusive: NonNullable<TaskLedgerStoreOptions["runExclusive"]> = async (work) => ({
  ok: true,
  value: await work()
});

function seedProfiles(storage: MemoryStorage, profiles = migrateLegacyProjectsToProfiles([{ id: "p1", name: "One" }], 100).store): ProjectProfilesStore {
  storage.seed(durableStoreKey("project-profiles"), JSON.stringify({
    schemaVersion: 1, revision: 1, updatedAt: profiles.updatedAt,
    records: Object.fromEntries(profiles.records.map((profile) => [profile.projectId, profile]))
  }));
  return profiles;
}

function draftLedger(profiles: ProjectProfilesStore): TaskLedgerStore {
  const profile = profiles.records[0];
  const task = {
    taskId: "t1", projectId: profile.projectId, objective: "Implement durable task storage",
    scope: "Adapter and tests only", acceptanceCriteria: ["Writes are project-scoped"],
    risk: "small" as const, priority: 1, dueAt: null, accountableCoordinator: "coordinator",
    specialistAssignments: [], dependencies: [], allowedTools: ["local-tests"],
    allowedResources: ["src/taskLedgerStore.ts"], allowedActions: ["read", "write"],
    policySnapshot: {
      constitutionVersion: "1.2", projectProfileRevision: profile.profileRevision,
      profileApprovalStatus: profile.approval.status, decisionReferences: []
    },
    state: "draft" as const, createdAt: 100, updatedAt: 100, attemptCount: 0,
    checkpoint: null, evidenceReferences: [], nextAction: "Run adapter tests",
    failureReason: null, recoveryInstructions: []
  };
  return {
    schemaVersion: 1, revision: 2, updatedAt: 100, records: [task],
    events: [{
      eventId: "created-1", taskId: "t1", projectId: profile.projectId,
      type: "task.created", actor: "coordinator", createdAt: 100, details: {}
    }]
  };
}

function makeStore() {
  const storage = new MemoryStorage();
  const profiles = seedProfiles(storage);
  const store = createTaskLedgerStore({ storage, now: () => 200, runExclusive });
  return { storage, profiles, store };
}

describe("durable task-ledger adapter", () => {
  it("writes and reads a project-scoped ledger with mandatory durable revision checks", async () => {
    const { store, profiles } = makeStore();
    const ledger = draftLedger(profiles);
    expect(await store.writeLedger("p1", ledger, 0)).toMatchObject({ ok: true, revision: 1 });
    expect(await store.readLedger("p1")).toMatchObject({ ok: true, status: "found", value: ledger });
    expect(await store.writeLedger("p1", ledger, 0)).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("does not expose another project's ledger through a project-scoped read", async () => {
    const { store } = makeStore();
    expect(await store.readLedger("p2")).toMatchObject({ ok: true, status: "empty", value: null });
  });

  it("rejects mismatched project IDs and invalid expected revisions", async () => {
    const { store, profiles } = makeStore();
    const ledger = draftLedger(profiles);
    expect(await store.writeLedger("p2", ledger, 0)).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.writeLedger("p1", ledger, -1)).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.writeLedger("p1", ledger, Number.NaN)).toMatchObject({ ok: false, reason: "invalid-data" });
  });

  it("requires the project profile to exist and validates policy snapshots against it", async () => {
    const { storage, profiles, store } = makeStore();
    storage.removeItem(durableStoreKey("project-profiles"));
    expect(await store.writeLedger("p1", draftLedger(profiles), 0))
      .toMatchObject({ ok: false, reason: "invalid-data" });
    seedProfiles(storage);
    const invalid = draftLedger(profiles);
    invalid.records[0].policySnapshot.projectProfileRevision = 99;
    expect(await store.writeLedger("p1", invalid, 0))
      .toMatchObject({ ok: false, reason: "invalid-data" });
  });

  it("keeps event history append-only across successive writes", async () => {
    const { store, profiles } = makeStore();
    const initial = draftLedger(profiles);
    expect(await store.writeLedger("p1", initial, 0)).toMatchObject({ ok: true, revision: 1 });
    const next: TaskLedgerStore = {
      ...initial, revision: 3, updatedAt: 101,
      events: [...initial.events, {
        eventId: "note-1", taskId: "t1", projectId: "p1",
        type: "task.note", actor: "coordinator", createdAt: 101, details: { note: "checkpoint" }
      }]
    };
    expect(await store.writeLedger("p1", next, 1)).toMatchObject({ ok: true, revision: 2 });
    const rewritten = { ...next, revision: 4, updatedAt: 102, events: [next.events[0]] };
    expect(await store.writeLedger("p1", rewritten, 2)).toMatchObject({ ok: false, reason: "invalid-data" });
    expect(await store.readLedger("p1")).toMatchObject({ ok: true, value: next });
  });

  it("rejects stale durable revisions without overwriting newer data", async () => {
    const { store, profiles } = makeStore();
    const initial = draftLedger(profiles);
    await store.writeLedger("p1", initial, 0);
    const next = { ...initial, revision: 3, updatedAt: 101, events: [...initial.events, {
      eventId: "note-1", taskId: "t1", projectId: "p1",
      type: "task.note", actor: "coordinator", createdAt: 101, details: {}
    }] };
    await store.writeLedger("p1", next, 1);
    expect(await store.writeLedger("p1", initial, 1)).toMatchObject({ ok: false, reason: "conflict" });
    expect(await store.readLedger("p1")).toMatchObject({ ok: true, value: next });
  });

  it("fails closed when the current profile envelope is malformed", async () => {
    const { storage, profiles, store } = makeStore();
    storage.seed(durableStoreKey("project-profiles"), JSON.stringify({
      schemaVersion: 1, revision: 1, updatedAt: 100, records: { p1: { projectId: "wrong" } }
    }));
    expect(await store.writeLedger("p1", draftLedger(profiles), 0))
      .toMatchObject({ ok: false, reason: "invalid-data" });
  });

  it("exposes recovery and snapshots but deliberately provides no legacy migration", async () => {
    const { store } = makeStore();
    expect(await store.recover()).toMatchObject({ ok: true });
    expect(await store.listSnapshots()).toEqual([]);
    expect("migrateLegacyTasks" in store).toBe(false);
  });
});
