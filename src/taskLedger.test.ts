import { describe, expect, it } from "vitest";
import {
  canTransitionTaskState,
  validateAppendOnlyLedgerUpdate,
  validateTaskLedgerStore,
  type TaskLedgerStore
} from "./taskLedger";

const baseTask = {
  taskId: "t1", projectId: "p1", objective: "Create the profile schema",
  scope: "Schema and validator only", acceptanceCriteria: ["Runtime validator exists", "Tests cover invalid input"],
  risk: "small" as const, priority: 1, dueAt: null, accountableCoordinator: "coordinator",
  specialistAssignments: [], dependencies: [], allowedTools: ["local-tests"],
  allowedResources: ["src/projectProfiles.ts"], allowedActions: ["read"],
  policySnapshot: { constitutionVersion: "1.1", projectProfileRevision: 1, profileApprovalStatus: "unapproved" as const, decisionReferences: [] },
  state: "queued" as const, createdAt: 100, updatedAt: 100, attemptCount: 0,
  checkpoint: null, evidenceReferences: [], nextAction: "Run the test suite",
  failureReason: null, recoveryInstructions: []
};
function storeWith(records: TaskLedgerStore["records"], events: TaskLedgerStore["events"] = []): TaskLedgerStore {
  return { schemaVersion: 1, revision: 1, updatedAt: 100, records, events };
}
describe("task ledger schema v1", () => {
  it("accepts a valid project-scoped task store", () => {
    expect(validateTaskLedgerStore(storeWith([baseTask])).ok).toBe(true);
  });
  it("cross-checks task project identity and policy snapshot when profiles are supplied", () => {
    const profiles = { schemaVersion: 1 as const, revision: 1, updatedAt: 100,
      records: [{ projectId: "p1", profileRevision: 1, createdAt: 1, updatedAt: 100,
        identity: { name: "One", purpose: "" }, lifecycle: "draft" as const, repositories: [], websites: [],
        technology: [], goals: [], governanceReferences: [], workflow: [], dataClassification: "unknown",
        allowedTools: [], forbiddenActions: [], releaseRules: [], risks: [], recoveryPlan: [], unknownFields: [],
        approval: { status: "unapproved" as const, approvedRevision: null, evidence: null, approvedAt: null,
          approvedContentHash: null, revokedAt: null, revokedRevision: null, revocationReason: null } }] };
    expect(validateTaskLedgerStore(storeWith([baseTask]), profiles).ok).toBe(true);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, projectId: "missing" }]), profiles).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, policySnapshot: { ...baseTask.policySnapshot, profileApprovalStatus: "approved" as const } }]), profiles).ok).toBe(false);
  });
  it("rejects future versions, unknown fields, and malformed enum values", () => {
    expect(validateTaskLedgerStore({ schemaVersion: 2, revision: 1, updatedAt: 100, records: [], events: [] }).ok).toBe(false);
    expect(validateTaskLedgerStore({ ...storeWith([baseTask]), hidden: true }).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, state: ["queued"] as unknown as "queued" }])).ok).toBe(false);
  });
  it("rejects tasks with missing, self, cyclic, or cross-project dependencies", () => {
    const other = { ...baseTask, taskId: "t2", projectId: "p2" };
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, dependencies: ["missing"] }])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, dependencies: ["t1"] }])).ok).toBe(false);
    const t1 = { ...baseTask, dependencies: ["t2"] };
    const t2 = { ...baseTask, taskId: "t2", dependencies: ["t1"] };
    expect(validateTaskLedgerStore(storeWith([t1, t2])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([other, { ...baseTask, taskId: "t3", dependencies: ["t2"] }])).ok).toBe(false);
  });
  it("rejects events for missing tasks, cross-project events, duplicate event IDs and idempotency keys", () => {
    const event = { eventId: "e1", taskId: "t1", projectId: "p1", type: "task.started", actor: "coordinator", createdAt: 101, outcome: "started" as const, idempotencyKey: "k1", details: {} };
    expect(validateTaskLedgerStore(storeWith([baseTask], [{ ...event, taskId: "missing" }])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([baseTask], [{ ...event, projectId: "p2" }])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([baseTask], [event, { ...event, eventId: "e2", idempotencyKey: "k2" }])).ok).toBe(true);
    expect(validateTaskLedgerStore(storeWith([baseTask], [event, { ...event, eventId: "e2" }])).ok).toBe(false);
  });
  it("requires checkpoints to match both task and project", () => {
    const checkpoint = { taskId: "t1", projectId: "p2", sequence: 1, createdAt: 101, summary: "x", completedCriteria: [], remainingWork: [], artifactReferences: [] };
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, checkpoint }])).ok).toBe(false);
  });
  it("rejects unknown keys and unsafe JSON in event details", () => {
    const event = { eventId: "e1", taskId: "t1", projectId: "p1", type: "task.started", actor: "coordinator", createdAt: 101, details: { hidden: true } };
    const bad = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(validateTaskLedgerStore(storeWith([baseTask], [{ ...event, details: bad }])).ok).toBe(false);
  });
  it("validates append-only event history", () => {
    const previous = storeWith([baseTask], [{ eventId: "e1", taskId: "t1", projectId: "p1", type: "task.created", actor: "coordinator", createdAt: 100, details: {} }]);
    const unchanged = storeWith([baseTask], [...previous.events, { eventId: "e2", taskId: "t1", projectId: "p1", type: "task.started", actor: "coordinator", createdAt: 101, details: {} }]);
    expect(validateAppendOnlyLedgerUpdate(previous, unchanged)).toBe(true);
    expect(validateAppendOnlyLedgerUpdate(previous, storeWith([baseTask], []))).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, storeWith([baseTask], [{ ...previous.events[0], type: "task.deleted" }]))).toBe(false);
  });
  it("requires a linked reconciliation event with evidence to leave indeterminate", () => {
    const ledger = storeWith([baseTask], [{
      eventId: "e1", taskId: "t1", projectId: "p1", type: "task.reconciled", actor: "coordinator",
      createdAt: 102, outcome: "succeeded", details: { resolution: "not-applied", evidenceReference: "audit:123" }
    }]);
    expect(canTransitionTaskState("indeterminate", "ready")).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "missing", taskId: "t1", projectId: "p1", ledger })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t2", projectId: "p1", ledger })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1", ledger })).toBe(true);
    expect(canTransitionTaskState("indeterminate", "failed", { eventId: "e1", taskId: "t1", projectId: "p1", ledger })).toBe(false);
  });
});
