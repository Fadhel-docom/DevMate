import { validateProjectProfilesStore, type ProjectProfilesStore } from "./projectProfiles";

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
const unsafeKeys = new Set(["__proto__", "prototype", "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
const storeKeys = ["schemaVersion", "revision", "updatedAt", "records", "events"];
const taskKeys = [
  "taskId", "projectId", "objective", "scope", "acceptanceCriteria", "risk", "priority", "dueAt",
  "accountableCoordinator", "specialistAssignments", "dependencies", "allowedTools", "allowedResources",
  "allowedActions", "policySnapshot", "state", "createdAt", "updatedAt", "attemptCount", "checkpoint",
  "evidenceReferences", "nextAction", "failureReason", "recoveryInstructions"
];
const MAX_JSON_DEPTH = 100;
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}
function isDenseDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" ||
    (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) return false;
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return Boolean(descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value"));
  }).every(Boolean);
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
function isJson(value: unknown, seen = new WeakSet<object>(), budget = { nodes: 0 }, depth = 0): value is JsonValue {
  budget.nodes += 1;
  if (budget.nodes > 10000 || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) valid = false;
    for (let i = 0; valid && i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        !isJson(descriptor.value, seen, budget, depth + 1)) { valid = false; break; }
    }
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (unsafeKeys.has(key) || !isJson(value[key], seen, budget, depth + 1)) { valid = false; break; }
    }
  } else valid = false;
  seen.delete(value);
  return valid;
}
function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function safeId(value: unknown): value is string {
  return requiredString(value) && value.trim() === value &&
    value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    !unsafeKeys.has(value);
}
function addError(errors: LedgerValidationError[], path: string, message: string) { errors.push({ path, message }); }

export function validateTaskLedgerStore(input: unknown, profiles?: ProjectProfilesStore): LedgerValidationResult {
  const errors: LedgerValidationError[] = [];
  const profilesValid = profiles === undefined || validateProjectProfilesStore(profiles).ok;
  if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "Expected a versioned task-ledger envelope." }] };
  if (!exactKeys(input, storeKeys)) addError(errors, "", "Unexpected or missing task-ledger fields.");
  if (input.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION) return { ok: false, errors: [{ path: "schemaVersion", message: `Unsupported schema version: ${String(input.schemaVersion)}.` }] };
  if (!isTimestamp(input.revision) || input.revision < 1) addError(errors, "revision", "Expected a positive store revision.");
  if (!isTimestamp(input.updatedAt)) addError(errors, "updatedAt", "Expected a non-negative timestamp.");
  if (!profilesValid) addError(errors, "profiles", "Supplied project profile store is invalid.");
  if (!isDenseDataArray(input.records)) addError(errors, "records", "Expected a dense data-only task array.");
  if (!isDenseDataArray(input.events)) addError(errors, "events", "Expected a dense data-only event array.");
  if (Array.isArray(input.records) && input.records.length > 2000) addError(errors, "records", "Task ledger exceeds the 2,000-task validation limit.");
  if (Array.isArray(input.events) && input.events.length > 10000) addError(errors, "events", "Task ledger exceeds the 10,000-event validation limit.");
  const taskById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(input.records)) input.records.forEach((task, index) => {
    const path = `records[${index}]`;
    if (!isRecord(task)) { addError(errors, path, "Expected a plain task object."); return; }
    if (!isJson(task)) { addError(errors, path, "Task contains unsafe, accessor, sparse, cyclic, non-JSON, or over-deep values."); return; }
    if (!exactKeys(task, taskKeys)) addError(errors, path, "Unexpected or missing task fields.");
    const check = (condition: boolean, field: string, message: string) => { if (!condition) addError(errors, `${path}.${field}`, message); };
    check(safeId(task.taskId), "taskId", "Expected a safe, trimmed task ID of at most 128 characters.");
    check(safeId(task.projectId), "projectId", "Every task must belong to a safe, trimmed project ID.");
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
    if (safeId(task.taskId)) {
      if (taskById.has(task.taskId)) addError(errors, `${path}.taskId`, "Duplicate task ID.");
      else taskById.set(task.taskId, task);
    }
    if (task.state === "queued" || task.state === "ready" || task.state === "in_progress" || task.state === "review" || task.state === "completed") {
      check(requiredString(task.objective) && requiredString(task.projectId) &&
        requiredString(task.accountableCoordinator) && isStringList(task.acceptanceCriteria) &&
        task.acceptanceCriteria.length > 0, "state", "This state requires objective, project, coordinator, and acceptance criteria.");
    }
    if (task.state === "indeterminate") check(requiredString(task.failureReason), "failureReason", "Indeterminate tasks must explain what needs reconciliation.");
    if (task.state === "completed") check(isStringList(task.evidenceReferences) &&
      task.evidenceReferences.length > 0 && isStringList(task.acceptanceCriteria) &&
      task.acceptanceCriteria.length > 0, "evidenceReferences",
      "Completed tasks require acceptance criteria and at least one evidence reference.");
    if (profiles && profilesValid && requiredString(task.projectId)) {
      const profile = profiles.records.find((item) => item.projectId === task.projectId);
      check(Boolean(profile), "projectId", "Task project does not exist in the supplied profile store.");
      // This is a historical snapshot. A later profile edit or revocation must
      // not invalidate tasks that were valid when they started.
      if (profile && !isRecord(task.policySnapshot)) check(false, "policySnapshot", "Missing historical policy snapshot.");
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

  let latestLedgerTimestamp = 0;
  if (Array.isArray(input.records)) input.records.forEach((task) => {
    if (isRecord(task) && isTimestamp(task.updatedAt)) latestLedgerTimestamp = Math.max(latestLedgerTimestamp, task.updatedAt);
  });
  const eventIds = new Set<string>(), idempotencyKeys = new Set<string>();
  if (Array.isArray(input.events)) input.events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!isRecord(event)) { addError(errors, path, "Expected a plain event object."); return; }
    if (!isJson(event)) { addError(errors, path, "Event contains unsafe, accessor, sparse, cyclic, non-JSON, or over-deep values."); return; }
    if (!exactKeys(event, ["eventId", "taskId", "projectId", "type", "actor", "createdAt", "details"], ["outcome", "idempotencyKey"])) addError(errors, path, "Unexpected or missing event fields.");
    if (!safeId(event.eventId) || !safeId(event.taskId) || !safeId(event.projectId) ||
      !requiredString(event.type) || !requiredString(event.actor) || !isTimestamp(event.createdAt) ||
      (event.outcome !== undefined && !actionOutcomes.has(event.outcome as TaskActionOutcome)) ||
      (event.idempotencyKey !== undefined && !requiredString(event.idempotencyKey)) ||
      !isRecord(event.details) || !isJson(event.details)) addError(errors, path, "Invalid event record.");
    if (isTimestamp(event.createdAt)) latestLedgerTimestamp = Math.max(latestLedgerTimestamp, event.createdAt);
    if (safeId(event.eventId)) {
      if (eventIds.has(event.eventId)) addError(errors, `${path}.eventId`, "Duplicate event ID.");
      eventIds.add(event.eventId);
    }
    if (requiredString(event.idempotencyKey) && safeId(event.projectId)) {
      const scopedKey = event.projectId + "\u0000" + event.idempotencyKey;
      if (idempotencyKeys.has(scopedKey)) addError(errors, `${path}.idempotencyKey`, "Duplicate idempotency key within project.");
      idempotencyKeys.add(scopedKey);
    }
    const task = safeId(event.taskId) ? taskById.get(event.taskId) : undefined;
    if (!task || task.projectId !== event.projectId) addError(errors, path, "Event must reference an existing task in the same project.");
  });
  if (isTimestamp(input.updatedAt) && input.updatedAt < latestLedgerTimestamp) addError(errors, "updatedAt", "Ledger timestamp cannot precede a task or event update.");
  const eventsByTask = new Map<string, Record<string, unknown>[]>();
  if (Array.isArray(input.events)) {
    for (const event of input.events) {
      if (!isRecord(event) || !requiredString(event.taskId)) continue;
      const bucket = eventsByTask.get(event.taskId) ?? [];
      bucket.push(event);
      eventsByTask.set(event.taskId, bucket);
    }
  }
  if (Array.isArray(input.records)) input.records.forEach((task, index) => {
    if (!isRecord(task) || task.state !== "completed") return;
    const criteria = task.acceptanceCriteria;
    const taskEvidence = task.evidenceReferences;
    const taskUpdatedAt = task.updatedAt;
    const taskEvents = safeId(task.taskId) ? eventsByTask.get(task.taskId) ?? [] : [];
    const verified = isStringList(criteria) && isStringList(taskEvidence) && isTimestamp(taskUpdatedAt) &&
      taskEvents.some((event) => {
        if (event.projectId !== task.projectId ||
          event.type !== "task.acceptance-verified" || event.outcome !== "succeeded" ||
          !isTimestamp(event.createdAt) || event.createdAt > taskUpdatedAt ||
          event.actor !== task.accountableCoordinator || !isRecord(event.details)) return false;
        const evidenceReference = event.details.evidenceReference;
        const verifiedCriteria = event.details.verifiedCriteria;
        return requiredString(evidenceReference) && isStringList(verifiedCriteria) &&
          criteria.every((criterion) => verifiedCriteria.includes(criterion)) &&
          taskEvidence.includes(evidenceReference);
      });
    if (!verified) addError(errors, `records[${index}].state`, "Completed tasks require a successful acceptance-verification event covering every criterion and linking stored evidence.");
  });
  // Node/depth budgets are enforced independently for each task and event.
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as TaskLedgerStore };
}

/** Verifies that a new ledger snapshot preserves every prior event unchanged and in order. */
export function validateAppendOnlyLedgerUpdate(
  previous: TaskLedgerStore,
  next: TaskLedgerStore,
  profiles?: ProjectProfilesStore
): boolean {
  if (!validateTaskLedgerStore(previous).ok || !validateTaskLedgerStore(next, profiles).ok ||
    next.revision <= previous.revision || next.updatedAt < previous.updatedAt ||
    next.events.length < previous.events.length) return false;
  const previousIds = new Set(previous.records.map((task) => task.taskId));
  const nextTasks = new Map(next.records.map((task) => [task.taskId, task]));
  if (!previous.records.every((task) => {
    const retained = nextTasks.get(task.taskId);
    return Boolean(retained && retained.projectId === task.projectId);
  })) return false;
  if (!previous.events.every((event, index) => JSON.stringify(event) === JSON.stringify(next.events[index]))) return false;
  const appendedEvents = next.events.slice(previous.events.length);
  const appendedEventsByTask = new Map<string, TaskLedgerEvent[]>();
  for (const event of appendedEvents) {
    const bucket = appendedEventsByTask.get(event.taskId) ?? [];
    bucket.push(event);
    appendedEventsByTask.set(event.taskId, bucket);
  }

  // New tasks are admitted only as clean drafts, accompanied by one creation
  // event, and with a policy snapshot matching the profile store at creation.
  for (const task of next.records) {
    if (previousIds.has(task.taskId)) continue;
    if (!profiles || task.state !== "draft" || task.attemptCount !== 0 ||
      task.evidenceReferences.length !== 0 || task.checkpoint !== null ||
      task.failureReason !== null || task.createdAt !== task.updatedAt) return false;
    const profile = profiles.records.find((item) => item.projectId === task.projectId);
    if (!profile || task.policySnapshot.projectProfileRevision !== profile.profileRevision ||
      task.policySnapshot.profileApprovalStatus !== profile.approval.status) return false;
    const creationEvents = appendedEventsByTask.get(task.taskId) ?? [];
    if (creationEvents.length !== 1) return false;
    const creation = creationEvents[0];
    if (creation.projectId !== task.projectId || creation.type !== "task.created" ||
      creation.actor !== task.accountableCoordinator || creation.createdAt < task.createdAt ||
      creation.createdAt > task.updatedAt) return false;
  }

  for (const priorTask of previous.records) {
    const updatedTask = nextTasks.get(priorTask.taskId);
    if (!updatedTask) return false;
    const taskChanged = JSON.stringify(priorTask) !== JSON.stringify(updatedTask);
    if (!taskChanged) continue;
    if (["completed", "failed", "cancelled"].includes(priorTask.state)) return false;
    if (updatedTask.taskId !== priorTask.taskId || updatedTask.projectId !== priorTask.projectId ||
      updatedTask.createdAt !== priorTask.createdAt ||
      updatedTask.attemptCount < priorTask.attemptCount ||
      JSON.stringify(priorTask.allowedTools) !== JSON.stringify(updatedTask.allowedTools) ||
      JSON.stringify(priorTask.allowedActions) !== JSON.stringify(updatedTask.allowedActions)) return false;
    if (priorTask.state !== "draft" &&
      JSON.stringify(priorTask.acceptanceCriteria) !== JSON.stringify(updatedTask.acceptanceCriteria)) return false;
    if (priorTask.checkpoint && (!updatedTask.checkpoint ||
      updatedTask.checkpoint.sequence < priorTask.checkpoint.sequence)) return false;
    if (JSON.stringify(priorTask.policySnapshot) !== JSON.stringify(updatedTask.policySnapshot)) return false;

    const matchingEvents = appendedEventsByTask.get(priorTask.taskId) ?? [];
    const event = matchingEvents[matchingEvents.length - 1];
    if (!event || event.actor !== priorTask.accountableCoordinator ||
      event.createdAt < priorTask.updatedAt || event.createdAt > updatedTask.updatedAt ||
      updatedTask.updatedAt <= priorTask.updatedAt) return false;
    let context: TaskTransitionContext | undefined;
    if (priorTask.state !== updatedTask.state) {
      if (priorTask.state === "indeterminate") {
        if (event.type !== "task.reconciled" || updatedTask.updatedAt <= event.createdAt) return false;
        const reconciliationLedger: TaskLedgerStore = {
          ...next,
          records: next.records.map((item) => item.taskId === priorTask.taskId ? priorTask : item)
        };
        context = { eventId: event.eventId, taskId: priorTask.taskId, projectId: priorTask.projectId, ledger: reconciliationLedger };
      } else if (updatedTask.state === "completed") {
        if (event.type !== "task.acceptance-verified") return false;
        context = { task: priorTask, event };
      } else if (priorTask.state === "blocked" && updatedTask.state === "ready") {
        if (event.type !== "task.blocker-resolved") return false;
        context = { task: priorTask, event };
      } else if (priorTask.state === "awaiting_owner" && updatedTask.state === "ready") {
        if (event.type !== "task.owner-decision-recorded") return false;
        context = { task: priorTask, event };
      } else if (priorTask.state === "review" && updatedTask.state === "ready") {
        if (event.type !== "task.review-rework-recorded") return false;
        context = { task: priorTask, event };
      } else if (event.type !== "task.state-changed" ||
        event.details.fromState !== priorTask.state || event.details.toState !== updatedTask.state) {
        return false;
      }
    }
    if (priorTask.state !== updatedTask.state && !canTransitionTaskState(priorTask.state, updatedTask.state, context)) return false;
  }
  return true;
}

const transitions: Record<TaskState, ReadonlySet<TaskState>> = {
  draft: new Set(["queued"]),
  queued: new Set(["ready", "cancelled"]),
  ready: new Set(["in_progress", "blocked", "awaiting_owner", "cancelled"]),
  in_progress: new Set(["review", "blocked", "awaiting_owner", "failed", "indeterminate"]),
  review: new Set(["ready", "blocked", "awaiting_owner", "completed"]),
  blocked: new Set(["ready", "cancelled"]),
  awaiting_owner: new Set(["ready"]),
  indeterminate: new Set(["ready", "failed", "cancelled"]),
  failed: new Set(), completed: new Set(), cancelled: new Set()
};
export type TaskCompletionEvidence = { task: LedgerTask; event: TaskLedgerEvent };
export type TaskTransitionEventEvidence = { task: LedgerTask; event: TaskLedgerEvent };
export type TaskTransitionContext = ReconciliationEvidence | TaskCompletionEvidence | TaskTransitionEventEvidence;
function eventSupportsTransition(task: LedgerTask, event: TaskLedgerEvent, expectedType: string): boolean {
  if (event.taskId !== task.taskId || event.projectId !== task.projectId ||
    event.type !== expectedType || event.outcome !== "succeeded" ||
    event.actor !== task.accountableCoordinator || event.createdAt < task.updatedAt ||
    !isRecord(event.details) || !requiredString(event.details.evidenceReference)) return false;
  return task.evidenceReferences.includes(event.details.evidenceReference);
}
/** Evidence-gated state transitions aligned with governance contract §14.2. */
export function canTransitionTaskState(from: TaskState, to: TaskState, context?: TaskTransitionContext): boolean {
  if (!transitions[from].has(to)) return false;
  if (from === "indeterminate") {
    if (!context || !("ledger" in context)) return false;
    const reconciliation = context as ReconciliationEvidence;
    if (!validateTaskLedgerStore(reconciliation.ledger).ok) return false;
    const task = reconciliation.ledger.records.find((item) => item.taskId === reconciliation.taskId && item.projectId === reconciliation.projectId);
    const event = reconciliation.ledger.events.find((item) => item.eventId === reconciliation.eventId);
    if (!task || task.state !== "indeterminate" || !event ||
      event.actor !== task.accountableCoordinator || event.createdAt < task.updatedAt ||
      event.type !== "task.reconciled" || event.outcome !== "succeeded" ||
      !isRecord(event.details) || !requiredString(event.details.evidenceReference) ||
      !task.evidenceReferences.includes(event.details.evidenceReference)) return false;
    const resolution = event.details.resolution;
    return (to === "ready" && resolution === "not-applied") ||
      (to === "failed" && resolution === "failed") ||
      (to === "cancelled" && resolution === "cancelled");
  }
  if (to === "completed") {
    if (!context || !("task" in context) || !("event" in context)) return false;
    const { task, event } = context as TaskCompletionEvidence;
    const verifiedCriteria = event.details.verifiedCriteria;
    return task.state === "review" && task.acceptanceCriteria.length > 0 &&
      task.evidenceReferences.length > 0 &&
      eventSupportsTransition(task, event, "task.acceptance-verified") &&
      isStringList(verifiedCriteria) &&
      task.acceptanceCriteria.every((criterion) => verifiedCriteria.includes(criterion));
  }
  if ((from === "blocked" || from === "awaiting_owner" || from === "review") && to === "ready") {
    if (!context || !("task" in context) || !("event" in context)) return false;
    const { task, event } = context as TaskTransitionEventEvidence;
    const expected = from === "blocked" ? "task.blocker-resolved" :
      from === "awaiting_owner" ? "task.owner-decision-recorded" : "task.review-rework-recorded";
    return eventSupportsTransition(task, event, expected);
  }
  return true;
}