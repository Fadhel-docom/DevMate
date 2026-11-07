import type { ProjectProfilesStore } from "./projectProfiles";

export const TASK_LEDGER_STORAGE_KEY = "devmate-task-ledger-v1";
export const TASK_LEDGER_SCHEMA_VERSION = 1 as const;

export type TaskState =
  | "draft" | "queued" | "ready" | "in_progress" | "review" | "completed"
  | "blocked" | "awaiting_owner" | "failed" | "cancelled" | "indeterminate";
export type TaskRisk = "small" | "standard" | "sensitive";
export type TaskActionOutcome = "planned" | "started" | "succeeded" | "failed" | "indeterminate";
export type TaskCheckpoint = {
  taskId: string;
  projectId: string;
  sequence: number;
  createdAt: number;
  summary: string;
  completedCriteria: string[];
  remainingWork: string[];
  artifactReferences: string[];
};
export type TaskPolicySnapshot = {
  constitutionVersion: string;
  projectProfileRevision: number;
  profileApprovalStatus: "unapproved" | "approved" | "revoked";
  decisionReferences: string[];
};
export type TaskLedgerEvent = {
  eventId: string;
  taskId: string;
  projectId: string;
  type: string;
  actor: string;
  createdAt: number;
  outcome?: TaskActionOutcome;
  idempotencyKey?: string;
  details: Record<string, JsonValue>;
};
export type LedgerTask = {
  taskId: string;
  projectId: string;
  objective: string;
  scope: string;
  acceptanceCriteria: string[];
  risk: TaskRisk;
  priority: number;
  dueAt: number | null;
  accountableCoordinator: string;
  specialistAssignments: Array<{ specialist: string; deliverable: string }>;
  dependencies: string[];
  allowedTools: string[];
  allowedResources: string[];
  allowedActions: string[];
  policySnapshot: TaskPolicySnapshot;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  attemptCount: number;
  checkpoint: TaskCheckpoint | null;
  evidenceReferences: string[];
  nextAction: string;
  failureReason: string | null;
  recoveryInstructions: string[];
};
export type TaskLedgerStore = {
  schemaVersion: typeof TASK_LEDGER_SCHEMA_VERSION;
  revision: number;
  updatedAt: number;
  records: LedgerTask[];
  events: TaskLedgerEvent[];
};
export type LedgerValidationError = { path: string; message: string };
export type LedgerValidationResult =
  | { ok: true; value: TaskLedgerStore }
  | { ok: false; errors: LedgerValidationError[] };
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ReconciliationEvidence = {
  eventId: string;
  taskId: string;
  projectId: string;
  ledger: TaskLedgerStore;
};

const taskStates = new Set<TaskState>([
  "draft", "queued", "ready", "in_progress", "review", "completed",
  "blocked", "awaiting_owner", "failed", "cancelled", "indeterminate"
]);
const riskLevels = new Set<TaskRisk>(["small", "standard", "sensitive"]);
const actionOutcomes = new Set<TaskActionOutcome>(["planned", "started", "succeeded", "failed", "indeterminate"]);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const storeKeys = ["schemaVersion", "revision", "updatedAt", "records", "events"];
const taskKeys = [
  "taskId", "projectId", "objective", "scope", "acceptanceCriteria", "risk", "priority", "dueAt",
  "accountableCoordinator", "specialistAssignments", "dependencies", "allowedTools", "allowedResources",
  "allowedActions", "policySnapshot", "state", "createdAt", "updatedAt", "attemptCount", "checkpoint",
  "evidenceReferences", "nextAction", "failureReason", "recoveryInstructions"
];
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...keys, ...optional]);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isJson(value: unknown, seen = new WeakSet<object>(), budget = { nodes: 0 }): value is JsonValue {
  budget.nodes += 1;
  if (budget.nodes > 10000) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i) || !isJson(value[i], seen, budget)) { valid = false; break; }
    }
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (unsafeKeys.has(key) || !isJson(value[key], seen, budget)) { valid = false; break; }
    }
  } else valid = false;
  seen.delete(value);
  return valid;
}
function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function addError(errors: LedgerValidationError[], path: string, message: string) { errors.push({ path, message }); }

export function validateTaskLedgerStore(input: unknown, profiles?: ProjectProfilesStore): LedgerValidationResult {
  const errors: LedgerValidationError[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "Expected a versioned task-ledger envelope." }] };
  if (!exactKeys(input, storeKeys)) addError(errors, "", "Unexpected or missing task-ledger fields.");
  if (input.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION) return { ok: false, errors: [{ path: "schemaVersion", message: `Unsupported schema version: ${String(input.schemaVersion)}.` }] };
  if (!isTimestamp(input.revision) || input.revision < 1) addError(errors, "revision", "Expected a positive store revision.");
  if (!isTimestamp(input.updatedAt)) addError(errors, "updatedAt", "Expected a non-negative timestamp.");
  if (!Array.isArray(input.records)) addError(errors, "records", "Expected a task array.");
  if (!Array.isArray(input.events)) addError(errors, "events", "Expected an event array.");
  const taskById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(input.records)) input.records.forEach((task, index) => {
    const path = `records[${index}]`;
    if (!isRecord(task)) { addError(errors, path, "Expected a plain task object."); return; }
    if (!exactKeys(task, taskKeys)) addError(errors, path, "Unexpected or missing task fields.");
    const check = (condition: boolean, field: string, message: string) => { if (!condition) addError(errors, `${path}.${field}`, message); };
    check(requiredString(task.taskId), "taskId", "Expected a non-empty task ID.");
    check(requiredString(task.projectId), "projectId", "Every task must belong to a project.");
    check(requiredString(task.objective), "objective", "Expected a bounded objective.");
    check(typeof task.scope === "string", "scope", "Expected a scope string.");
    check(isStringList(task.acceptanceCriteria), "acceptanceCriteria", "Expected acceptance criteria as strings.");
    check(riskLevels.has(task.risk as TaskRisk), "risk", "Invalid risk classification.");
    check(typeof task.priority === "number" && Number.isFinite(task.priority), "priority", "Expected a finite priority.");
    check(task.dueAt === null || isTimestamp(task.dueAt), "dueAt", "Expected null or a non-negative timestamp.");
    check(requiredString(task.accountableCoordinator), "accountableCoordinator", "Every task needs one accountable coordinator.");
    check(Array.isArray(task.specialistAssignments) && task.specialistAssignments.every((item) =>
      isRecord(item) && exactKeys(item, ["specialist", "deliverable"]) && requiredString(item.specialist) && requiredString(item.deliverable)),
    "specialistAssignments", "Assignments need exactly a specialist and a non-empty deliverable.");
    check(isStringList(task.dependencies), "dependencies", "Expected dependency task IDs.");
    check(isStringList(task.allowedTools), "allowedTools", "Expected an explicit tools list.");
    check(isStringList(task.allowedResources), "allowedResources", "Expected an explicit resources list.");
    check(isStringList(task.allowedActions), "allowedActions", "Expected an explicit actions list.");
    check(isRecord(task.policySnapshot) && exactKeys(task.policySnapshot,
      ["constitutionVersion", "projectProfileRevision", "profileApprovalStatus", "decisionReferences"]) &&
      requiredString(task.policySnapshot.constitutionVersion) &&
      typeof task.policySnapshot.projectProfileRevision === "number" &&
      Number.isSafeInteger(task.policySnapshot.projectProfileRevision) && task.policySnapshot.projectProfileRevision >= 1 &&
      (task.policySnapshot.profileApprovalStatus === "unapproved" || task.policySnapshot.profileApprovalStatus === "approved" || task.policySnapshot.profileApprovalStatus === "revoked") &&
      isStringList(task.policySnapshot.decisionReferences), "policySnapshot", "Invalid policy snapshot.");
    check(taskStates.has(task.state as TaskState), "state", "Invalid task state.");
    check(isTimestamp(task.createdAt) && isTimestamp(task.updatedAt) && (task.updatedAt as number) >= (task.createdAt as number),
      "timestamps", "Expected non-negative timestamps with updatedAt >= createdAt.");
    check(Number.isSafeInteger(task.attemptCount) && (task.attemptCount as number) >= 0, "attemptCount", "Expected a non-negative attempt count.");
    if (task.checkpoint !== null) {
      const checkpoint = task.checkpoint;
      check(isRecord(checkpoint) && exactKeys(checkpoint, [
        "taskId", "projectId", "sequence", "createdAt", "summary", "completedCriteria", "remainingWork", "artifactReferences"
      ]) && checkpoint.taskId === task.taskId && checkpoint.projectId === task.projectId &&
        Number.isSafeInteger(checkpoint.sequence) && (checkpoint.sequence as number) >= 1 &&
        isTimestamp(checkpoint.createdAt) && typeof checkpoint.summary === "string" &&
        isStringList(checkpoint.completedCriteria) && isStringList(checkpoint.remainingWork) &&
        isStringList(checkpoint.artifactReferences), "checkpoint", "Checkpoint must match its task and project and contain valid fields.");
    }
    check(isStringList(task.evidenceReferences), "evidenceReferences", "Expected evidence references.");
    check(typeof task.nextAction === "string", "nextAction", "Expected a next-action string.");
    check(task.failureReason === null || typeof task.failureReason === "string", "failureReason", "Expected null or a string.");
    check(isStringList(task.recoveryInstructions), "recoveryInstructions", "Expected recovery instructions.");
    if (requiredString(task.taskId)) {
      if (taskById.has(task.taskId)) addError(errors, `${path}.taskId`, "Duplicate task ID.");
      else taskById.set(task.taskId, task);
    }
    if (task.state === "queued" || task.state === "ready" || task.state === "in_progress" || task.state === "review" || task.state === "completed") {
      check(requiredString(task.objective) && requiredString(task.projectId) &&
        requiredString(task.accountableCoordinator) && isStringList(task.acceptanceCriteria) &&
        task.acceptanceCriteria.length > 0, "state", "This state requires objective, project, coordinator, and acceptance criteria.");
    }
    if (task.state === "indeterminate") check(requiredString(task.failureReason), "failureReason", "Indeterminate tasks must explain what needs reconciliation.");
    if (profiles && requiredString(task.projectId)) {
      const profile = profiles.records.find((item) => item.projectId === task.projectId);
      check(Boolean(profile), "projectId", "Task project does not exist in the supplied profile store.");
      if (profile && isRecord(task.policySnapshot)) {
        check(task.policySnapshot.projectProfileRevision === profile.profileRevision &&
          task.policySnapshot.profileApprovalStatus === profile.approval.status,
        "policySnapshot", "Policy snapshot does not match the current project profile revision and approval status.");
      }
    }
  });
  const graph = new Map<string, string[]>();
  if (Array.isArray(input.records)) input.records.forEach((task, index) => {
    if (!isRecord(task) || !requiredString(task.taskId) || !requiredString(task.projectId) || !isStringList(task.dependencies)) return;
    graph.set(task.taskId, task.dependencies);
    for (const dependencyId of task.dependencies) {
      const dependency = taskById.get(dependencyId);
      if (!dependency) addError(errors, `records[${index}].dependencies`, `Unknown dependency task ID: ${dependencyId}.`);
      else if (dependency.projectId !== task.projectId) addError(errors, `records[${index}].dependencies`, "Cross-project task dependencies are denied.");
      if (dependencyId === task.taskId) addError(errors, `records[${index}].dependencies`, "A task cannot depend on itself.");
    }
  });
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) if (graph.has(dependency) && !visit(dependency)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  for (const id of graph.keys()) if (!visit(id)) { addError(errors, "records.dependencies", "Dependency cycle detected."); break; }

  const eventIds = new Set<string>(), idempotencyKeys = new Set<string>();
  if (Array.isArray(input.events)) input.events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!isRecord(event)) { addError(errors, path, "Expected a plain event object."); return; }
    if (!exactKeys(event, ["eventId", "taskId", "projectId", "type", "actor", "createdAt", "details"], ["outcome", "idempotencyKey"])) addError(errors, path, "Unexpected or missing event fields.");
    if (!requiredString(event.eventId) || !requiredString(event.taskId) || !requiredString(event.projectId) ||
      !requiredString(event.type) || !requiredString(event.actor) || !isTimestamp(event.createdAt) ||
      (event.outcome !== undefined && !actionOutcomes.has(event.outcome as TaskActionOutcome)) ||
      (event.idempotencyKey !== undefined && !requiredString(event.idempotencyKey)) ||
      !isRecord(event.details) || !isJson(event.details)) addError(errors, path, "Invalid event record.");
    if (requiredString(event.eventId)) {
      if (eventIds.has(event.eventId)) addError(errors, `${path}.eventId`, "Duplicate event ID.");
      eventIds.add(event.eventId);
    }
    if (requiredString(event.idempotencyKey)) {
      if (idempotencyKeys.has(event.idempotencyKey)) addError(errors, `${path}.idempotencyKey`, "Duplicate idempotency key.");
      idempotencyKeys.add(event.idempotencyKey);
    }
    const task = taskById.get(String(event.taskId));
    if (!task || task.projectId !== event.projectId) addError(errors, path, "Event must reference an existing task in the same project.");
  });
  if (!isJson(input)) addError(errors, "", "Ledger contains unsafe keys, prototypes, sparse arrays, cycles, or non-JSON values.");
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as TaskLedgerStore };
}

/** Verifies that a new ledger snapshot preserves every prior event unchanged and in order. */
export function validateAppendOnlyLedgerUpdate(previous: TaskLedgerStore, next: TaskLedgerStore): boolean {
  if (next.events.length < previous.events.length) return false;
  return previous.events.every((event, index) => JSON.stringify(event) === JSON.stringify(next.events[index]));
}

const transitions: Record<TaskState, ReadonlySet<TaskState>> = {
  draft: new Set(["queued", "cancelled"]),
  queued: new Set(["ready", "blocked", "cancelled"]),
  ready: new Set(["in_progress", "blocked", "awaiting_owner", "cancelled"]),
  in_progress: new Set(["review", "blocked", "awaiting_owner", "failed", "indeterminate"]),
  review: new Set(["completed", "ready", "blocked", "awaiting_owner"]),
  blocked: new Set(["ready", "cancelled"]),
  awaiting_owner: new Set(["ready", "cancelled"]),
  indeterminate: new Set(["ready", "failed", "cancelled"]),
  failed: new Set(), completed: new Set(), cancelled: new Set()
};
/**
 * An indeterminate task can leave its hold state only when the supplied event
 * is present in the ledger, is scoped to that task/project, and records an
 * explicit reconciliation resolution plus an evidence reference.
 */
export function canTransitionTaskState(from: TaskState, to: TaskState, reconciliation?: ReconciliationEvidence): boolean {
  if (!transitions[from].has(to)) return false;
  if (from !== "indeterminate") return true;
  if (!reconciliation) return false;
  const event = reconciliation.ledger.events.find((item) => item.eventId === reconciliation.eventId);
  if (!event || event.taskId !== reconciliation.taskId || event.projectId !== reconciliation.projectId ||
    event.type !== "task.reconciled" || !requiredString(event.details.evidenceReference)) return false;
  const resolution = event.details.resolution;
  return (to === "ready" && resolution === "not-applied") ||
    (to === "failed" && resolution === "failed") ||
    (to === "cancelled" && resolution === "cancelled");
}
