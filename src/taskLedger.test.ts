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
  const latest = Math.max(100, ...records.map((task) => task.updatedAt), ...events.map((event) => event.createdAt));
  return { schemaVersion: 1, revision: 1, updatedAt: latest, records, events };
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
          approvedContentHash: null, revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: [] } }] };
    expect(validateTaskLedgerStore(storeWith([baseTask]), profiles).ok).toBe(true);
    const changedCurrentProfile = { ...profiles, revision: 2, updatedAt: 200,
      records: [{ ...profiles.records[0], profileRevision: 2, updatedAt: 200 }] };
    expect(validateTaskLedgerStore(storeWith([baseTask]), changedCurrentProfile).ok).toBe(true);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, projectId: "missing" }]), profiles).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, policySnapshot: { ...baseTask.policySnapshot, profileApprovalStatus: "approved" as const } }]), profiles).ok).toBe(true);
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
    const unchanged = { ...storeWith([baseTask], [...previous.events, { eventId: "e2", taskId: "t1", projectId: "p1", type: "task.started", actor: "coordinator", createdAt: 101, details: {} }]), revision: 2, updatedAt: 101 };
    expect(validateAppendOnlyLedgerUpdate(previous, unchanged)).toBe(true);
    expect(validateAppendOnlyLedgerUpdate(previous, storeWith([baseTask], []))).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...unchanged, events: [{ ...previous.events[0], type: "task.deleted" }] })).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...unchanged, revision: 1 })).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...unchanged, records: [] })).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...unchanged, records: [{ ...baseTask, state: "completed" }] })).toBe(false);
  });
  it("requires a linked reconciliation event with evidence to leave indeterminate", () => {
    const ledger = storeWith([{ ...baseTask, state: "indeterminate" as const, failureReason: "Outcome unknown", evidenceReferences: ["audit:123"] }], [{
      eventId: "e1", taskId: "t1", projectId: "p1", type: "task.reconciled", actor: "coordinator",
      createdAt: 102, outcome: "succeeded", details: { resolution: "not-applied", evidenceReference: "audit:123" }
    }]);
    expect(canTransitionTaskState("indeterminate", "ready")).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "missing", taskId: "t1", projectId: "p1", ledger })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t2", projectId: "p1", ledger })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1", ledger })).toBe(true);
    expect(canTransitionTaskState("indeterminate", "ready", {
      eventId: "e1", taskId: "t1", projectId: "p1",
      ledger: storeWith([baseTask], ledger.events)
    })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "failed", { eventId: "e1", taskId: "t1", projectId: "p1", ledger })).toBe(false);
  });

  it("rejects stale, unlinked, wrong-actor, and reused reconciliation events", () => {
    const task = { ...baseTask, state: "indeterminate" as const, failureReason: "Unknown outcome", evidenceReferences: ["audit:123"] };
    const event = { eventId: "e1", taskId: "t1", projectId: "p1", type: "task.reconciled", actor: "coordinator",
      createdAt: 102, outcome: "succeeded" as const, details: { resolution: "not-applied", evidenceReference: "audit:123" } };
    const valid = storeWith([task], [event]);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1", ledger: valid })).toBe(true);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1",
      ledger: storeWith([{ ...task, updatedAt: 103 }], [event]) })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1",
      ledger: storeWith([{ ...task, evidenceReferences: [] }], [event]) })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1",
      ledger: storeWith([task], [{ ...event, actor: "unrelated-agent" }]) })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1",
      ledger: storeWith([task], [{ ...event, type: "task.started" }]) })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1",
      ledger: storeWith([task], [{ ...event, outcome: "failed" }]) })).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", { eventId: "e1", taskId: "t1", projectId: "p1",
      ledger: { ...valid, revision: 0 } })).toBe(false);
  });
  it("requires verifiable acceptance evidence before a task can be completed", () => {
    const reviewTask = { ...baseTask, state: "review" as const, updatedAt: 101, evidenceReferences: ["artifact:1"] };
    const verification = { eventId: "verify-1", taskId: "t1", projectId: "p1", type: "task.acceptance-verified",
      actor: "coordinator", createdAt: 102, outcome: "succeeded" as const,
      details: { evidenceReference: "artifact:1", verifiedCriteria: [...baseTask.acceptanceCriteria] } };
    expect(canTransitionTaskState("review", "completed", { task: reviewTask, event: verification })).toBe(true);
    expect(canTransitionTaskState("review", "completed")).toBe(false);
    const completed = { ...reviewTask, state: "completed" as const, updatedAt: 103 };
    expect(validateTaskLedgerStore(storeWith([completed], [verification])).ok).toBe(true);
    expect(validateTaskLedgerStore(storeWith([completed], [])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([{ ...completed, evidenceReferences: [] }], [verification])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([completed], [{ ...verification, details: { evidenceReference: "artifact:1", verifiedCriteria: ["one"] } }])).ok).toBe(false);
  });
  it("enforces documented transition gates for queued, blocked, and owner states", () => {
    expect(canTransitionTaskState("queued", "blocked")).toBe(false);
    expect(canTransitionTaskState("draft", "cancelled")).toBe(false);
    expect(canTransitionTaskState("awaiting_owner", "cancelled")).toBe(false);
    const blocked = { ...baseTask, state: "blocked" as const, updatedAt: 101, evidenceReferences: ["fix:1"] };
    const resolved = { eventId: "resolve-1", taskId: "t1", projectId: "p1", type: "task.blocker-resolved",
      actor: "coordinator", createdAt: 102, outcome: "succeeded" as const, details: { evidenceReference: "fix:1" } };
    expect(canTransitionTaskState("blocked", "ready", { task: blocked, event: resolved })).toBe(true);
    expect(canTransitionTaskState("blocked", "ready")).toBe(false);
  });
  it("supports the documented collection limits without an aggregate JSON budget", () => {
    const tasks = Array.from({ length: 300 }, (_, index) => ({ ...baseTask, taskId: `t${index}` }));
    const events = Array.from({ length: 1300 }, (_, index) => ({
      eventId: `e${index}`, taskId: "t0", projectId: "p1", type: "task.note",
      actor: "coordinator", createdAt: 101 + index, details: {}
    }));
    expect(validateTaskLedgerStore({ schemaVersion: 1, revision: 1, updatedAt: 2000, records: tasks, events }).ok).toBe(true);
  });
  it("rejects accessors, sparse arrays, cycles, non-finite values, and deep JSON", () => {
    const getterTask = { ...baseTask } as Record<string, unknown>;
    Object.defineProperty(getterTask, "objective", { enumerable: true, get: () => "Create the profile schema" });
    expect(validateTaskLedgerStore(storeWith([getterTask as never])).ok).toBe(false);
    const sparseTask = { ...baseTask, acceptanceCriteria: new Array(1) };
    expect(validateTaskLedgerStore(storeWith([sparseTask as never])).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const event = { eventId: "e1", taskId: "t1", projectId: "p1", type: "task.note", actor: "coordinator", createdAt: 101, details: { cyclic } };
    expect(validateTaskLedgerStore(storeWith([baseTask], [event as never])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, priority: Number.POSITIVE_INFINITY }])).ok).toBe(false);
    let deep: unknown = "leaf";
    for (let index = 0; index < 120; index += 1) deep = { child: deep };
    expect(validateTaskLedgerStore(storeWith([baseTask], [{ ...event, details: { deep } } as never])).ok).toBe(false);
  });
  it("applies node budgets per task and event instead of across the entire ledger", () => {
    const oversizedTask = { ...baseTask, allowedResources: Array(10001).fill("resource") };
    expect(validateTaskLedgerStore(storeWith([oversizedTask])).ok).toBe(false);
    const oversizedEvent = { eventId: "e1", taskId: "t1", projectId: "p1", type: "task.note",
      actor: "coordinator", createdAt: 101, details: { values: Array(10001).fill("x") } };
    expect(validateTaskLedgerStore(storeWith([baseTask], [oversizedEvent])).ok).toBe(false);
  });
  it("accepts per-project idempotency keys and rejects unsafe task and project IDs", () => {
    const task2 = { ...baseTask, taskId: "t2", projectId: "p2" };
    const event1 = { eventId: "e1", taskId: "t1", projectId: "p1", type: "task.note", actor: "coordinator", createdAt: 101, idempotencyKey: "same", details: {} };
    const event2 = { eventId: "e2", taskId: "t2", projectId: "p2", type: "task.note", actor: "coordinator", createdAt: 102, idempotencyKey: "same", details: {} };
    expect(validateTaskLedgerStore(storeWith([baseTask, task2], [event1, event2])).ok).toBe(true);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, taskId: "__proto__" }])).ok).toBe(false);
    expect(validateTaskLedgerStore(storeWith([{ ...baseTask, projectId: " p1 " }])).ok).toBe(false);
  });


  it("requires a recorded review-rework finding before returning to ready", () => {
    const reviewTask = { ...baseTask, state: "review" as const, updatedAt: 101, evidenceReferences: ["review:1"] };
    const event = { eventId: "rework-1", taskId: "t1", projectId: "p1", type: "task.review-rework-recorded",
      actor: "coordinator", createdAt: 102, outcome: "succeeded" as const, details: { evidenceReference: "review:1" } };
    expect(canTransitionTaskState("review", "ready", { task: reviewTask, event })).toBe(true);
    expect(canTransitionTaskState("review", "ready")).toBe(false);
  });


  it("consumes reconciliation events when persisting the state transition", () => {
    const priorTask = { ...baseTask, state: "indeterminate" as const, failureReason: "Outcome unknown", evidenceReferences: ["audit:9"] };
    const previous = storeWith([priorTask], []);
    const event = { eventId: "reconcile-9", taskId: "t1", projectId: "p1", type: "task.reconciled",
      actor: "coordinator", createdAt: 102, outcome: "succeeded" as const,
      details: { resolution: "not-applied", evidenceReference: "audit:9" } };
    const nextTask = { ...priorTask, state: "ready" as const, updatedAt: 103, failureReason: null };
    const next = { ...storeWith([nextTask], [event]), revision: 2 };
    expect(validateAppendOnlyLedgerUpdate(previous, next)).toBe(true);
    const unconsumed = { ...next, records: [{ ...nextTask, updatedAt: 102 }] };
    expect(validateAppendOnlyLedgerUpdate(previous, unconsumed)).toBe(false);
  });


  it("requires an append-only state-change event and a newer task timestamp", () => {
    const previous = storeWith([baseTask], []);
    const readyTask = { ...baseTask, state: "ready" as const, updatedAt: 102 };
    const stateEvent = { eventId: "state-1", taskId: "t1", projectId: "p1", type: "task.state-changed",
      actor: "coordinator", createdAt: 101, details: { fromState: "queued", toState: "ready" } };
    expect(validateAppendOnlyLedgerUpdate(previous, { ...storeWith([readyTask], [stateEvent]), revision: 2 })).toBe(true);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...storeWith([readyTask], []), revision: 2 })).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...storeWith([readyTask], [stateEvent]), revision: 2,
      records: [{ ...readyTask, updatedAt: 100 }] })).toBe(false);
  });


  it("requires task snapshot edits to be audited and keeps the start policy snapshot immutable", () => {
    const previous = storeWith([baseTask], []);
    const changed = { ...baseTask, updatedAt: 102, scope: "Changed scope" };
    expect(validateAppendOnlyLedgerUpdate(previous, { ...storeWith([changed], []), revision: 2 })).toBe(false);
    const updateEvent = { eventId: "update-1", taskId: "t1", projectId: "p1", type: "task.updated",
      actor: "coordinator", createdAt: 101, details: { changedFields: ["scope"] } };
    expect(validateAppendOnlyLedgerUpdate(previous, { ...storeWith([changed], [updateEvent]), revision: 2 })).toBe(true);
    const changedSnapshot = { ...baseTask, updatedAt: 102,
      policySnapshot: { ...baseTask.policySnapshot, projectProfileRevision: 2 } };
    const snapshotEvent = { eventId: "update-2", taskId: "t1", projectId: "p1", type: "task.updated",
      actor: "coordinator", createdAt: 101, details: { changedFields: ["policySnapshot"] } };
    expect(validateAppendOnlyLedgerUpdate(previous, { ...storeWith([changedSnapshot], [snapshotEvent]), revision: 2 })).toBe(false);
  });

  it("admits only clean draft task creation with a single event and matching profile snapshot", () => {
    const profile = { projectId: "p1", profileRevision: 1, createdAt: 1, updatedAt: 100,
      identity: { name: "One", purpose: "" }, lifecycle: "draft" as const, repositories: [], websites: [],
      technology: [], goals: [], governanceReferences: [], workflow: [], dataClassification: "unknown",
      allowedTools: [], forbiddenActions: [], releaseRules: [], risks: [], recoveryPlan: [], unknownFields: [],
      approval: { status: "unapproved" as const, approvedRevision: null, evidence: null, approvedAt: null,
        approvedContentHash: null, revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: [] } };
    const profiles = { schemaVersion: 1 as const, revision: 1, updatedAt: 100, records: [profile] };
    const draft = { ...baseTask, state: "draft" as const };
    const created = { eventId: "create-1", taskId: "t1", projectId: "p1", type: "task.created",
      actor: "coordinator", createdAt: 100, details: {} };
    const previous = storeWith([]);
    const next = { ...storeWith([draft], [created]), revision: 2 };
    expect(validateAppendOnlyLedgerUpdate(previous, next, profiles)).toBe(true);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...next, records: [{ ...draft, state: "ready" as const }] }, profiles)).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...next, records: [{ ...draft, state: "completed" as const,
      evidenceReferences: ["fabricated"], updatedAt: 100 }] }, profiles)).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...next, events: [] }, profiles)).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...next, records: [{ ...draft, attemptCount: 1 }] }, profiles)).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...next, records: [{ ...draft, evidenceReferences: ["fabricated"] }] }, profiles)).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, { ...next, records: [{ ...draft,
      policySnapshot: { ...draft.policySnapshot, projectProfileRevision: 99 } }] }, profiles)).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, next)).toBe(false);
  });

  it("prevents immutable identity, criteria, permission, counter, checkpoint, and terminal-task rewrites", () => {
    const previous = storeWith([baseTask]);
    const update = (task: typeof baseTask, eventType = "task.updated") => ({
      ...storeWith([task], [{ eventId: "change-1", taskId: "t1", projectId: "p1",
        type: eventType, actor: "coordinator", createdAt: 101, details: { changedFields: ["scope"] } }]),
      revision: 2
    });
    expect(validateAppendOnlyLedgerUpdate(previous, update({ ...baseTask, taskId: "renamed", updatedAt: 102 }))).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, update({ ...baseTask, createdAt: 99, updatedAt: 102 }))).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, update({ ...baseTask, acceptanceCriteria: ["weakened"], updatedAt: 102 }))).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, update({ ...baseTask, allowedTools: [], updatedAt: 102 }))).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, update({ ...baseTask, allowedActions: ["delete"], updatedAt: 102 }))).toBe(false);
    expect(validateAppendOnlyLedgerUpdate(previous, update({ ...baseTask, attemptCount: 0, updatedAt: 102 }))).toBe(true);
    const attempted = { ...baseTask, attemptCount: 1, updatedAt: 102 };
    expect(validateAppendOnlyLedgerUpdate(previous, update(attempted))).toBe(true);
    const attemptedPrevious = storeWith([{ ...baseTask, attemptCount: 1 }]);
    const lowered = { ...baseTask, attemptCount: 0, updatedAt: 102 };
    expect(validateAppendOnlyLedgerUpdate(attemptedPrevious, update(lowered))).toBe(false);
    const checkpointPrevious = storeWith([{ ...baseTask, checkpoint: {
      taskId: "t1", projectId: "p1", sequence: 2, createdAt: 101, summary: "checkpoint",
      completedCriteria: [], remainingWork: [], artifactReferences: []
    } }]);
    const loweredCheckpoint = { ...checkpointPrevious.records[0], checkpoint: {
      ...checkpointPrevious.records[0].checkpoint!, sequence: 1
    }, updatedAt: 102 };
    expect(validateAppendOnlyLedgerUpdate(checkpointPrevious, update(loweredCheckpoint))).toBe(false);
    const finalTask = { ...baseTask, state: "completed" as const, updatedAt: 102,
      evidenceReferences: ["artifact:1"] };
    const finalPrevious = storeWith([finalTask], [{
      eventId: "verify-final", taskId: "t1", projectId: "p1", type: "task.acceptance-verified",
      actor: "coordinator", createdAt: 101, outcome: "succeeded" as const,
      details: { evidenceReference: "artifact:1", verifiedCriteria: [...baseTask.acceptanceCriteria] }
    }]);
    const editedFinal = { ...finalTask, scope: "rewritten", updatedAt: 103 };
    const finalNext = { ...storeWith([editedFinal], [...finalPrevious.events, {
      eventId: "edit-final", taskId: "t1", projectId: "p1", type: "task.updated",
      actor: "coordinator", createdAt: 102, details: { changedFields: ["scope"] }
    }]), revision: 2 };
    expect(validateAppendOnlyLedgerUpdate(finalPrevious, finalNext)).toBe(false);
  });

  it("validates the declared 2,000-task and 10,000-event scale without quadratic completion scans", () => {
    const tasks = Array.from({ length: 2000 }, (_, index) => ({
      ...baseTask, taskId: `t${index}`, state: "completed" as const,
      updatedAt: 200, evidenceReferences: [`artifact:${index}`]
    }));
    const events = Array.from({ length: 10000 }, (_, index) => {
      const taskIndex = Math.floor(index / 5);
      const taskId = `t${taskIndex}`;
      return index % 5 === 0 ? {
        eventId: `e${index}`, taskId, projectId: "p1", type: "task.acceptance-verified",
        actor: "coordinator", createdAt: 101, outcome: "succeeded" as const,
        details: { evidenceReference: `artifact:${taskIndex}`, verifiedCriteria: [...baseTask.acceptanceCriteria] }
      } : {
        eventId: `e${index}`, taskId, projectId: "p1", type: "task.note",
        actor: "coordinator", createdAt: 102 + index, details: {}
      };
    });
    const full = { schemaVersion: 1 as const, revision: 1, updatedAt: 11000, records: tasks, events };
    expect(validateTaskLedgerStore(full).ok).toBe(true);
    const next = { ...full, revision: 2 };
    expect(validateAppendOnlyLedgerUpdate(full, next)).toBe(true);
  });


});
