import { describe, expect, it } from "vitest";
import {
  canTransitionTaskState,
  validateTaskLedgerStore,
  type TaskLedgerStore
} from "./taskLedger";

const baseTask = {
  taskId: "t1",
  projectId: "p1",
  objective: "Create the profile schema",
  scope: "Schema and validator only",
  acceptanceCriteria: ["Runtime validator exists", "Tests cover invalid input"],
  risk: "small" as const,
  priority: 1,
  dueAt: null,
  accountableCoordinator: "coordinator",
  specialistAssignments: [],
  dependencies: [],
  allowedTools: ["local-tests"],
  allowedResources: ["src/projectProfiles.ts"],
  allowedActions: ["read", "write-branch"],
  policySnapshot: {
    constitutionVersion: "1.1",
    projectProfileRevision: 1,
    profileApprovalStatus: "approved" as const,
    decisionReferences: []
  },
  state: "queued" as const,
  createdAt: 100,
  updatedAt: 100,
  attemptCount: 0,
  checkpoint: null,
  evidenceReferences: [],
  nextAction: "Run the test suite",
  failureReason: null,
  recoveryInstructions: []
};

function storeWith(records: TaskLedgerStore["records"]): TaskLedgerStore {
  return { schemaVersion: 1, revision: 1, updatedAt: 100, records, events: [] };
}

describe("task ledger schema v1", () => {
  it("accepts a valid project-scoped task store", () => {
    expect(validateTaskLedgerStore(storeWith([baseTask])).ok).toBe(true);
  });

  it("rejects future schema versions", () => {
    expect(validateTaskLedgerStore({ schemaVersion: 2, revision: 1, updatedAt: 100, records: [], events: [] }).ok).toBe(false);
  });

  it("rejects ready work without acceptance criteria", () => {
    const task = { ...baseTask, acceptanceCriteria: [] };
    expect(validateTaskLedgerStore(storeWith([task])).ok).toBe(false);
  });

  it("rejects duplicate task IDs", () => {
    expect(validateTaskLedgerStore(storeWith([baseTask, { ...baseTask }])).ok).toBe(false);
  });

  it("rejects cross-project dependencies", () => {
    const other = { ...baseTask, taskId: "t2", projectId: "p2" };
    const dependent = { ...baseTask, taskId: "t3", dependencies: ["t2"] };
    expect(validateTaskLedgerStore(storeWith([other, dependent])).ok).toBe(false);
  });

  it("rejects events that cross project boundaries", () => {
    const ledger: TaskLedgerStore = {
      ...storeWith([baseTask]),
      events: [{
        eventId: "e1",
        taskId: "t1",
        projectId: "p2",
        type: "task.started",
        actor: "coordinator",
        createdAt: 101,
        outcome: "started",
        details: {}
      }]
    };
    expect(validateTaskLedgerStore(ledger).ok).toBe(false);
  });

  it("requires reconciliation before leaving indeterminate", () => {
    expect(canTransitionTaskState("indeterminate", "ready")).toBe(false);
    expect(canTransitionTaskState("indeterminate", "ready", true)).toBe(true);
    expect(canTransitionTaskState("in_progress", "review")).toBe(true);
    expect(canTransitionTaskState("completed", "ready")).toBe(false);
  });
});
