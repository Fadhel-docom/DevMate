export const PROJECT_PROFILES_STORAGE_KEY = "devmate-project-profiles-v1";
export const PROJECT_PROFILE_SCHEMA_VERSION = 1 as const;

export type ProfileApprovalEvidence = {
  kind: "owner-decision" | "approved-pull-request";
  reference: string;
  commitSha: string | null;
};

export type ProfileApproval = {
  status: "unapproved" | "approved" | "revoked";
  approvedRevision: number | null;
  evidence: ProfileApprovalEvidence | null;
  approvedAt: number | null;
};

export type ProjectProfile = {
  projectId: string;
  profileRevision: number;
  createdAt: number;
  updatedAt: number;
  identity: { name: string; purpose: string };
  lifecycle: "draft" | "active" | "archived";
  repositories: string[];
  websites: string[];
  technology: string[];
  goals: string[];
  governanceReferences: string[];
  workflow: string[];
  dataClassification: string;
  allowedTools: string[];
  forbiddenActions: string[];
  releaseRules: string[];
  risks: string[];
  recoveryPlan: string[];
  unknownFields: string[];
  approval: ProfileApproval;
  extensions?: Record<string, JsonValue>;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ProjectProfilesStore = {
  schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  revision: number;
  updatedAt: number;
  records: ProjectProfile[];
};

export type ProfileValidationError = { path: string; message: string };
export type ProfileValidationResult =
  | { ok: true; value: ProjectProfilesStore }
  | { ok: false; errors: ProfileValidationError[] };

export type LegacyProject = { id: string; name: string };

const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const listFields = [
  "repositories", "websites", "technology", "goals", "governanceReferences",
  "workflow", "allowedTools", "forbiddenActions", "releaseRules", "risks",
  "recoveryPlan", "unknownFields"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 40) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isSafeJson(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => !dangerousKeys.has(key) && isSafeJson(value[key], depth + 1));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function addError(errors: ProfileValidationError[], path: string, message: string) {
  errors.push({ path, message });
}

function validateProfile(value: unknown, index: number, errors: ProfileValidationError[]): value is ProjectProfile {
  const root = `records[${index}]`;
  if (!isRecord(value)) {
    addError(errors, root, "Expected an object.");
    return false;
  }
  let valid = true;
  const check = (condition: boolean, path: string, message: string) => {
    if (!condition) { addError(errors, `${root}.${path}`, message); valid = false; }
  };
  check(typeof value.projectId === "string" && value.projectId.trim().length > 0, "projectId", "Expected a non-empty stable project ID.");
  check(isNonNegativeInteger(value.profileRevision) && value.profileRevision >= 1, "profileRevision", "Expected a positive integer.");
  check(isNonNegativeInteger(value.createdAt), "createdAt", "Expected a non-negative timestamp.");
  check(isNonNegativeInteger(value.updatedAt), "updatedAt", "Expected a non-negative timestamp.");
  check(isRecord(value.identity) && typeof value.identity.name === "string" && value.identity.name.trim().length > 0, "identity.name", "Expected a non-empty project name.");
  check(isRecord(value.identity) && typeof value.identity.purpose === "string", "identity.purpose", "Expected a purpose string; use an empty string when unknown.");
  check(["draft", "active", "archived"].includes(String(value.lifecycle)), "lifecycle", "Invalid lifecycle value.");
  for (const field of listFields) {
    check(Array.isArray(value[field]) && (value[field] as unknown[]).every((item) => typeof item === "string"), field, "Expected an array of strings.");
  }
  check(typeof value.dataClassification === "string" && value.dataClassification.length > 0, "dataClassification", "Expected an explicit classification or 'unknown'.");
  check(isRecord(value.approval), "approval", "Expected approval metadata.");
  if (isRecord(value.approval)) {
    const approval = value.approval;
    check(["unapproved", "approved", "revoked"].includes(String(approval.status)), "approval.status", "Invalid approval status.");
    check(approval.approvedRevision === null || (isNonNegativeInteger(approval.approvedRevision) && approval.approvedRevision >= 1), "approval.approvedRevision", "Expected null or a positive revision.");
    check(approval.approvedAt === null || isNonNegativeInteger(approval.approvedAt), "approval.approvedAt", "Expected null or a non-negative timestamp.");
    check(approval.evidence === null || (isRecord(approval.evidence) &&
      ["owner-decision", "approved-pull-request"].includes(String(approval.evidence.kind)) &&
      typeof approval.evidence.reference === "string" && approval.evidence.reference.trim().length > 0 &&
      (approval.evidence.commitSha === null || typeof approval.evidence.commitSha === "string")), "approval.evidence", "Invalid approval evidence.");
    if (approval.status === "approved") {
      check(approval.approvedRevision === value.profileRevision && approval.evidence !== null && approval.approvedAt !== null, "approval", "Approved status must reference the current revision, evidence, and approval time.");
    } else {
      check(approval.approvedRevision === null && approval.evidence === null && approval.approvedAt === null, "approval", "Unapproved or revoked profiles cannot retain active approval evidence.");
    }
  }
  if (value.extensions !== undefined) check(isRecord(value.extensions) && isSafeJson(value.extensions), "extensions", "Extensions must contain safe JSON values only.");
  check(isSafeJson(value), "", "Profile contains unsafe keys or non-JSON values.");
  return valid;
}

export function validateProjectProfilesStore(input: unknown): ProfileValidationResult {
  const errors: ProfileValidationError[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "Expected a versioned store envelope." }] };
  if (input.schemaVersion !== PROJECT_PROFILE_SCHEMA_VERSION) {
    return { ok: false, errors: [{ path: "schemaVersion", message: `Unsupported schema version: ${String(input.schemaVersion)}.` }] };
  }
  if (!isNonNegativeInteger(input.revision) || input.revision < 1) addError(errors, "revision", "Expected a positive integer.");
  if (!isNonNegativeInteger(input.updatedAt)) addError(errors, "updatedAt", "Expected a non-negative timestamp.");
  if (!Array.isArray(input.records)) addError(errors, "records", "Expected an array of project profiles.");
  const ids = new Set<string>();
  if (Array.isArray(input.records)) {
    input.records.forEach((record, index) => {
      if (validateProfile(record, index, errors) && typeof record.projectId === "string") {
        if (ids.has(record.projectId)) addError(errors, `records[${index}].projectId`, "Duplicate project ID.");
        ids.add(record.projectId);
      }
    });
  }
  if (!isSafeJson(input)) addError(errors, "", "Store contains unsafe keys or non-JSON values.");
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as ProjectProfilesStore };
}

/**
 * Pure, additive migration from the legacy workspace. The caller must back up
 * the original payload before persisting this result and verify it by reading
 * it back. Existing project/task storage is deliberately left untouched.
 */
export function migrateLegacyProjectsToProfiles(
  legacyProjects: readonly LegacyProject[],
  migratedAt: number
): ProjectProfilesStore {
  if (!isNonNegativeInteger(migratedAt)) throw new RangeError("Migration timestamp must be a non-negative integer.");
  const seen = new Set<string>();
  const records = legacyProjects.map((project) => {
    if (!project.id.trim() || !project.name.trim() || seen.has(project.id)) {
      throw new TypeError("Legacy projects must have unique non-empty IDs and names.");
    }
    seen.add(project.id);
    return {
      projectId: project.id,
      profileRevision: 1,
      createdAt: migratedAt,
      updatedAt: migratedAt,
      identity: { name: project.name, purpose: "" },
      lifecycle: "draft" as const,
      repositories: [],
      websites: [],
      technology: [],
      goals: [],
      governanceReferences: [],
      workflow: [],
      dataClassification: "unknown",
      allowedTools: [],
      forbiddenActions: [],
      releaseRules: [],
      risks: [],
      recoveryPlan: [],
      unknownFields: [
        "purpose", "repositories", "websites", "technology", "goals",
        "governanceReferences", "workflow", "dataClassification", "allowedTools",
        "forbiddenActions", "releaseRules", "risks", "recoveryPlan"
      ],
      approval: { status: "unapproved" as const, approvedRevision: null, evidence: null, approvedAt: null }
    };
  });
  const store: ProjectProfilesStore = {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    revision: 1,
    updatedAt: migratedAt,
    records
  };
  const checked = validateProjectProfilesStore(store);
  if (!checked.ok) throw new TypeError(`Generated profile migration failed validation: ${checked.errors.map((error) => error.path).join(", ")}`);
  return checked.value;
}
