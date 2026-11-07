export const TASK_LEDGER_STORAGE_KEY = "devmate-task-ledger-v1";
export const TASK_LEDGER_SCHEMA_VERSION = 1 as const;

export type TaskState =
  | "draft" | "queued" | "ready" | "in_progress" | "review" | "completed"
  | "blocked" | "awaiting_owner" | "failed" | "cancelled" | "indeterminate";
export type TaskRisk = "small" | "standard" | "sensitive";
export type TaskActionOutcome = "planned" | "started" | "succeeded" | "failed" | "indeterminate";

export type TaskCheckpoint = {
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

const taskStates = new Set<TaskState>([
  "draft", "queued", "ready", "in_progress", "review", "completed",
  "blocked", "awaiting_owner", "failed", "cancelled", "indeterminate"
]);
const riskLevels = new Set<TaskRisk>(["small", "standard", "sensitive"]);
const actionOutcomes = new Set<TaskActionOutcome>(["planned", "started", "succeeded", "failed", "indeterminate"]);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 40) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => !unsafeKeys.has(key) && isJson(value[key], depth + 1));
}
function error(errors: LedgerValidationError[], path: string, message: string) {
  errors.push({ path, message });
}
function requiredString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateTaskLedgerStore(input: unknown): LedgerValidationResult {
  const errors: LedgerValidationError[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "Expected a versioned task-ledger envelope." }] };
  if (input.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION) {
    return { ok: false, errors: [{ path: "schemaVersion", message: `Unsupported schema version: ${String(input.schemaVersion)}.` }] };
  }
  if (!isTimestamp(input.revision) || input.revision < 1) error(errors, "revision", "Expected a positive store revision.");
  if (!isTimestamp(input.updatedAt)) error(errors, "updatedAt", "Expected a non-negative timestamp.");
  if (!Array.isArray(input.records)) error(errors, "records", "Expected a task array.");
  if (!Array.isArray(input.events)) error(errors, "events", "Expected an event array.");

  const taskIds = new Set<string>();
  const taskProject = new Map<string, string>();
  if (Array.isArray(input.records)) {
    input.records.forEach((task, index) => {
      const path = `records[${index}]`;
      if (!isRecord(task)) { error(errors, path, "Expected a task object."); return; }
      const check = (condition: boolean, field: string, message: string) => { if (!condition) error(errors, `${path}.${field}`, message); };
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
        isRecord(item) && requiredString(item.specialist) && requiredString(item.deliverable)), "specialistAssignments", "Assignments need a specialist and a non-empty deliverable.");
      check(isStringList(task.dependencies), "dependencies", "Expected dependency task IDs.");
      check(isStringList(task.allowedTools), "allowedTools", "Expected an explicit tools list.");
      check(isStringList(task.allowedResources), "allowedResources", "Expected an explicit resources list.");
      check(isStringList(task.allowedActions), "allowedActions", "Expected an explicit actions list.");
      check(isRecord(task.policySnapshot) &&
        requiredString(task.policySnapshot.constitutionVersion) &&
        typeof task.policySnapshot.projectProfileRevision === "number" &&
        Number.isSafeInteger(task.policySnapshot.projectProfileRevision) &&
        task.policySnapshot.projectProfileRevision >= 1 &&
        ["unapproved", "approved", "revoked"].includes(String(task.policySnapshot.profileApprovalStatus)) &&
        isStringList(task.policySnapshot.decisionReferences), "policySnapshot", "Invalid policy snapshot.");
      check(taskStates.has(task.state as TaskState), "state", "Invalid task state.");
      check(isTimestamp(task.createdAt) && isTimestamp(task.updatedAt), "timestamps", "Expected non-negative timestamps.");
      check(Number.isSafeInteger(task.attemptCount) && (task.attemptCount as number) >= 0, "attemptCount", "Expected a non-negative attempt count.");
      check(task.checkpoint === null || (isRecord(task.checkpoint) &&
        Number.isSafeInteger(task.checkpoint.sequence) && (task.checkpoint.sequence as number) >= 1 &&
        isTimestamp(task.checkpoint.createdAt) && typeof task.checkpoint.summary === "string" &&
        isStringList(task.checkpoint.completedCriteria) && isStringList(task.checkpoint.remainingWork) &&
        isStringList(task.checkpoint.artifactReferences)), "checkpoint", "Invalid checkpoint.");
      check(isStringList(task.evidenceReferences), "evidenceReferences", "Expected evidence references.");
      check(typeof task.nextAction === "string", "nextAction", "Expected a next-action string.");
      check(task.failureReason === null || typeof task.failureReason === "string", "failureReason", "Expected null or a string.");
      check(isStringList(task.recoveryInstructions), "recoveryInstructions", "Expected recovery instructions.");
      if (requiredString(task.taskId) && requiredString(task.projectId)) {
        if (taskIds.has(task.taskId)) error(errors, `${path}.taskId`, "Duplicate task ID.");
        taskIds.add(task.taskId);
        taskProject.set(task.taskId, task.projectId);
      }
      if (task.state === "queued" || task.state === "ready" || task.state === "in_progress" || task.state === "review" || task.state === "completed") {
        check(requiredString(task.objective) && requiredString(task.projectId) &&
          requiredString(task.accountableCoordinator) && isStringList(task.acceptanceCriteria) &&
          task.acceptanceCriteria.length > 0, "state", "This state requires objective, project, coordinator, and acceptance criteria.");
      }
      if (task.state === "indeterminate") {
        check(requiredString(task.failureReason), "failureReason", "Indeterminate tasks must explain what needs reconciliation.");
      }
    });
  }
  if (Array.isArray(input.records)) {
    input.records.forEach((task, index) => {
      if (!isRecord(task) || !requiredString(task.taskId) || !requiredString(task.projectId) || !isStringList(task.dependencies)) return;
      for (const dependencyId of task.dependencies) {
        const dependencyProject = taskProject.get(dependencyId);
        if (dependencyProject !== undefined && dependencyProject !== task.projectId) {
          error(errors, `records[${index}].dependencies`, "Cross-project task dependencies are denied.");
        } else if (dependencyProject === undefined) {
          error(errors, `records[${index}].dependencies`, `Unknown dependency task ID: ${dependencyId}.`);
        }
      }
    });
  }
  const eventIds = new Set<string>();
  if (Array.isArray(input.events)) {
    input.events.forEach((event, index) => {
      const path = `events[${index}]`;
      if (!isRecord(event)) { error(errors, path, "Expected an event object."); return; }
      if (!requiredString(event.eventId) || !requiredString(event.taskId) || !requiredString(event.projectId) ||
          !requiredString(event.type) || !requiredString(event.actor) || !isTimestamp(event.createdAt) ||
          (event.outcome !== undefined && !actionOutcomes.has(event.outcome as TaskActionOutcome)) ||
          (event.idempotencyKey !== undefined && !requiredString(event.idempotencyKey)) ||
          !isRecord(event.details) || !isJson(event.details)) {
        error(errors, path, "Invalid event record.");
      }
      if (requiredString(event.eventId)) {
        if (eventIds.has(event.eventId)) error(errors, `${path}.eventId`, "Duplicate event ID.");
        eventIds.add(event.eventId);
      }
      const task = Array.isArray(input.records) ? input.records.find((item) =>
        isRecord(item) && item.taskId === event.taskId) : undefined;
      if (!isRecord(task) || task.projectId !== event.projectId) {
        error(errors, path, "Event must reference an existing task in the same project.");
      }
    });
  }
  if (!isJson(input)) error(errors, "", "Ledger contains unsafe keys or non-JSON values.");
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as TaskLedgerStore };
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
  failed: new Set(),
  completed: new Set(),
  cancelled: new Set()
};

/** State transition policy. Indeterminate recovery must be explicitly reconciled first. */
export function canTransitionTaskState(from: TaskState, to: TaskState, reconciled = false): boolean {
  if (from === "indeterminate" && !reconciled) return false;
  return transitions[from].has(to);
}
