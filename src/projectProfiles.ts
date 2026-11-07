export const PROJECT_PROFILES_STORAGE_KEY = "devmate-project-profiles-v1";
export const PROJECT_PROFILE_SCHEMA_VERSION = 1 as const;

export type ProfileApprovalEvidence = {
  kind: "owner-decision" | "approved-pull-request";
  reference: string;
  commitSha: string | null;
};
export type ProfileRevocationRecord = {
  approvedRevision: number;
  evidence: ProfileApprovalEvidence;
  approvedAt: number;
  approvedContentHash: string;
  revokedAt: number;
  revocationReason: string;
};
export type ProfileApproval = {
  status: "unapproved" | "approved" | "revoked";
  approvedRevision: number | null;
  evidence: ProfileApprovalEvidence | null;
  approvedAt: number | null;
  approvedContentHash: string | null;
  revokedAt: number | null;
  revokedRevision: number | null;
  revocationReason: string | null;
  /** Append-only history of earlier revoked approvals, retained across re-approval. */
  revocationHistory: ProfileRevocationRecord[];
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
export type LegacyMigrationRejection = { index: number; reason: string };
export type LegacyMigrationResult = { store: ProjectProfilesStore; rejected: LegacyMigrationRejection[] };

const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const listFields = [
  "repositories", "websites", "technology", "goals", "governanceReferences",
  "workflow", "allowedTools", "forbiddenActions", "releaseRules", "risks",
  "recoveryPlan", "unknownFields"
] as const;
const profileKeys = [
  "projectId", "profileRevision", "createdAt", "updatedAt", "identity", "lifecycle",
  ...listFields, "dataClassification", "approval", "extensions"
];
const approvalKeys = [
  "status", "approvedRevision", "evidence", "approvedAt", "approvedContentHash",
  "revokedAt", "revokedRevision", "revocationReason", "revocationHistory"
];

const MAX_JSON_DEPTH = 100;
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}
function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}
function isSafeJson(value: unknown, seen = new WeakSet<object>(), budget = { nodes: 0 }, depth = 0): value is JsonValue {
  budget.nodes += 1;
  if (budget.nodes > 10000 || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) valid = false;
    for (let i = 0; valid && i < value.length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        !isSafeJson(descriptor.value, seen, budget, depth + 1)) { valid = false; break; }
    }
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (dangerousKeys.has(key) || !isSafeJson(value[key], seen, budget, depth + 1)) { valid = false; break; }
    }
  } else {
    valid = false;
  }
  seen.delete(value);
  return valid;
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value >= 1;
}
function addError(errors: ProfileValidationError[], path: string, message: string) {
  errors.push({ path, message });
}
function hashText(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") { const serialized = JSON.stringify(value); if (serialized === undefined) throw new TypeError("Value is not JSON serializable."); return serialized; }
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (!isRecord(value)) throw new TypeError("Profile content must be plain JSON.");
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}
/**
 * Deterministic non-cryptographic content fingerprint. It detects accidental or
 * unversioned edits; it is NOT an authentication or authorization primitive.
 */
export function computeProfileContentHash(profile: ProjectProfile): string {
  if (!isSafeJson(profile)) throw new TypeError("Profile content must be bounded, accessor-free plain JSON.");
  const { approval: _approval, updatedAt: _updatedAt, ...controlledContent } = profile;
  const canonical = stableJson(controlledContent);
  return hashText(canonical, 2166136261) + hashText(canonical, 2246822519);
}

/**
 * Pure guard for profile approval-history updates. Re-approval after revocation
 * must archive the exact revoked evidence before the current approval is replaced.
 * Persistence must call this alongside the store revision check.
 */
export function validateProfileApprovalHistoryUpdate(previous: ProfileApproval, next: ProfileApproval): boolean {
  try {
    if (!isRecord(previous) || !isRecord(next) ||
      !hasExactKeys(previous, approvalKeys) || !hasExactKeys(next, approvalKeys) ||
      !isSafeJson(previous) || !isSafeJson(next) ||
      !Array.isArray(previous.revocationHistory) || !Array.isArray(next.revocationHistory)) return false;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (next.revocationHistory.length < previous.revocationHistory.length ||
      !previous.revocationHistory.every((entry, index) => same(entry, next.revocationHistory[index]))) return false;
    const previousHistoryLength = previous.revocationHistory.length;
    const appended = next.revocationHistory.length - previousHistoryLength;
    const archiveCurrent = () => ({
      approvedRevision: previous.approvedRevision,
      evidence: previous.evidence,
      approvedAt: previous.approvedAt,
      approvedContentHash: previous.approvedContentHash,
      revokedAt: previous.revokedAt,
      revocationReason: previous.revocationReason
    });
    const validApproval = (value: ProfileApproval) =>
      value.approvedRevision !== null && isPositiveInteger(value.approvedRevision) &&
      validateEvidence(value.evidence) && isNonNegativeInteger(value.approvedAt) &&
      typeof value.approvedContentHash === "string" && /^[0-9a-f]{16}$/i.test(value.approvedContentHash);
    const validRevocation = (value: ProfileApproval) =>
      validApproval(value) && isNonNegativeInteger(value.revokedAt) &&
      value.revokedAt >= (value.approvedAt as number) &&
      value.revokedRevision === value.approvedRevision &&
      typeof value.revocationReason === "string" && value.revocationReason.trim().length > 0;
    if (previous.status === "unapproved") {
      if (appended !== 0 || previous.approvedRevision !== null || previous.evidence !== null ||
        previous.approvedAt !== null || previous.approvedContentHash !== null ||
        previous.revokedAt !== null || previous.revokedRevision !== null || previous.revocationReason !== null) return false;
      if (next.status === "unapproved") return same(previous, next);
      return next.status === "approved" && validApproval(next) &&
        next.revokedAt === null && next.revokedRevision === null && next.revocationReason === null;
    }
    if (previous.status === "approved") {
      if (!validApproval(previous) || previous.revokedAt !== null || previous.revokedRevision !== null ||
        previous.revocationReason !== null) return false;
      if (next.status === "approved") return appended === 0 && same(previous, next);
      if (next.status !== "revoked" || appended !== 0 || !validRevocation(next)) return false;
      return next.approvedRevision === previous.approvedRevision &&
        same(next.evidence, previous.evidence) && next.approvedAt === previous.approvedAt &&
        next.approvedContentHash === previous.approvedContentHash;
    }
    if (previous.status === "revoked") {
      if (!validRevocation(previous)) return false;
      const archived = archiveCurrent();
      if (next.status === "revoked") return appended === 0 && same(previous, next);
      if (next.status === "approved") return appended === 1 &&
        same(next.revocationHistory[previousHistoryLength], archived) &&
        validApproval(next) && next.revokedAt === null && next.revokedRevision === null && next.revocationReason === null;
      if (next.status === "unapproved") return appended === 1 &&
        same(next.revocationHistory[previousHistoryLength], archived) &&
        next.approvedRevision === null && next.evidence === null && next.approvedAt === null &&
        next.approvedContentHash === null && next.revokedAt === null &&
        next.revokedRevision === null && next.revocationReason === null;
    }
    return false;
  } catch {
    return false;
  }
}
function validateEvidence(value: unknown): value is ProfileApprovalEvidence {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "reference", "commitSha"])) return false;
  if (value.kind !== "owner-decision" && value.kind !== "approved-pull-request") return false;
  if (typeof value.reference !== "string" || value.reference.trim().length === 0) return false;
  if (value.kind === "approved-pull-request") return typeof value.commitSha === "string" && /^[0-9a-f]{40}$/i.test(value.commitSha);
  return value.commitSha === null || (typeof value.commitSha === "string" && /^[0-9a-f]{40}$/i.test(value.commitSha));
}
function validateProfile(value: unknown, index: number, errors: ProfileValidationError[]): value is ProjectProfile {
  const root = `records[${index}]`;
  if (!isRecord(value)) { addError(errors, root, "Expected a plain object."); return false; }
  let valid = true;
  const check = (condition: boolean, path: string, message: string) => {
    if (!condition) { addError(errors, path ? `${root}.${path}` : root, message); valid = false; }
  };
  check(hasExactKeys(value, profileKeys.filter((key) => key !== "extensions"), ["extensions"]), "", "Unexpected or missing profile fields.");
  check(typeof value.projectId === "string" && value.projectId.length > 0 && value.projectId.trim() === value.projectId && !dangerousKeys.has(value.projectId), "projectId", "Expected a safe, trimmed stable project ID.");
  check(isPositiveInteger(value.profileRevision), "profileRevision", "Expected a positive integer.");
  check(isNonNegativeInteger(value.createdAt), "createdAt", "Expected a non-negative timestamp.");
  check(isNonNegativeInteger(value.updatedAt) && isNonNegativeInteger(value.createdAt) && (value.updatedAt as number) >= (value.createdAt as number), "updatedAt", "Expected updatedAt >= createdAt.");
  check(isRecord(value.identity) && hasExactKeys(value.identity, ["name", "purpose"]) &&
    typeof value.identity.name === "string" && value.identity.name.trim().length > 0 &&
    typeof value.identity.purpose === "string", "identity", "Expected exactly name and purpose strings.");
  check(value.lifecycle === "draft" || value.lifecycle === "active" || value.lifecycle === "archived", "lifecycle", "Invalid lifecycle value.");
  for (const field of listFields) {
    const list = value[field];
    check(Array.isArray(list) && list.every((item) => typeof item === "string"), field, "Expected an array of strings.");
  }
  if (Array.isArray(value.repositories)) {
    const normalizedRepositories = value.repositories.map((item) => item.trim().toLowerCase());
    check(normalizedRepositories.every(Boolean) &&
      new Set(normalizedRepositories).size === normalizedRepositories.length,
      "repositories", "Repository identifiers must be non-empty and unique.");
  }
  check(typeof value.dataClassification === "string" && value.dataClassification.trim().length > 0, "dataClassification", "Expected an explicit classification or 'unknown'.");
  check(isRecord(value.approval) && hasExactKeys(value.approval, approvalKeys), "approval", "Expected exact approval metadata fields.");
  if (isRecord(value.approval)) {
    const a = value.approval;
    check(a.status === "unapproved" || a.status === "approved" || a.status === "revoked", "approval.status", "Invalid approval status.");
    check(a.approvedRevision === null || isPositiveInteger(a.approvedRevision), "approval.approvedRevision", "Expected null or a positive revision.");
    check(a.approvedAt === null || isNonNegativeInteger(a.approvedAt), "approval.approvedAt", "Expected null or a non-negative timestamp.");
    check(a.evidence === null || validateEvidence(a.evidence), "approval.evidence", "Invalid approval evidence; approved PR evidence requires a 40-character commit SHA.");
    check(a.approvedContentHash === null || (typeof a.approvedContentHash === "string" && /^[0-9a-f]{16}$/i.test(a.approvedContentHash)), "approval.approvedContentHash", "Expected null or a 16-character content fingerprint.");
    check(a.revokedAt === null || isNonNegativeInteger(a.revokedAt), "approval.revokedAt", "Expected null or a non-negative timestamp.");
    check(a.revokedRevision === null || isPositiveInteger(a.revokedRevision), "approval.revokedRevision", "Expected null or a positive revision.");
    check(a.revocationReason === null || (typeof a.revocationReason === "string" && a.revocationReason.trim().length > 0), "approval.revocationReason", "Expected null or a non-empty revocation reason.");
    check(Array.isArray(a.revocationHistory) && a.revocationHistory.every((entry, historyIndex) =>
      isRecord(entry) && hasExactKeys(entry, [
        "approvedRevision", "evidence", "approvedAt", "approvedContentHash", "revokedAt", "revocationReason"
      ]) && isPositiveInteger(entry.approvedRevision) && validateEvidence(entry.evidence) &&
      isNonNegativeInteger(entry.approvedAt) && isNonNegativeInteger(entry.revokedAt) &&
      entry.revokedAt >= entry.approvedAt &&
      (historyIndex === 0 || a.revocationHistory[historyIndex - 1].revokedAt <= entry.revokedAt) &&
      typeof entry.approvedContentHash === "string" && /^[0-9a-f]{16}$/i.test(entry.approvedContentHash) &&
      typeof entry.revocationReason === "string" && entry.revocationReason.trim().length > 0
    ), "approval.revocationHistory", "Expected an ordered array of complete, valid prior revocation records.");
    if (a.status === "unapproved") {
      check(a.approvedRevision === null && a.evidence === null && a.approvedAt === null && a.approvedContentHash === null &&
        a.revokedAt === null && a.revokedRevision === null && a.revocationReason === null,
      "approval", "Unapproved profiles cannot retain approval or revocation metadata.");
    } else if (a.status === "approved") {
      check(a.approvedRevision === value.profileRevision && a.evidence !== null && a.approvedAt !== null &&
        a.approvedContentHash === (isSafeJson(value) ? computeProfileContentHash(value as unknown as ProjectProfile) : null) &&
        a.revokedAt === null && a.revokedRevision === null && a.revocationReason === null,
      "approval", "Approved status must match the current profile revision and content fingerprint, with valid evidence and no revocation metadata.");
    } else {
      check(a.approvedRevision !== null && a.evidence !== null && a.approvedAt !== null &&
        a.approvedContentHash !== null && a.revokedAt !== null && a.revokedRevision === a.approvedRevision &&
        a.revocationReason !== null && (a.revokedAt as number) >= (a.approvedAt as number) &&
        isPositiveInteger(value.profileRevision) && (a.revokedRevision as number) <= value.profileRevision,
      "approval", "Revoked status must preserve the prior approval evidence and record when, which revision, and why it was revoked.");
    }
  }
  if (value.extensions !== undefined) {
    check(isRecord(value.extensions) && isSafeJson(value.extensions), "extensions", "Extensions must contain safe plain JSON values only.");
  }
  check(isSafeJson(value), "", "Profile contains unsafe keys, prototypes, sparse arrays, cycles, or non-JSON values.");
  return valid;
}

export function validateProjectProfilesStore(input: unknown): ProfileValidationResult {
  const errors: ProfileValidationError[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: "", message: "Expected a versioned store envelope." }] };
  if (!hasExactKeys(input, ["schemaVersion", "revision", "updatedAt", "records"])) addError(errors, "", "Unexpected or missing store fields.");
  if (input.schemaVersion !== PROJECT_PROFILE_SCHEMA_VERSION) return { ok: false, errors: [{ path: "schemaVersion", message: `Unsupported schema version: ${String(input.schemaVersion)}.` }] };
  if (!isPositiveInteger(input.revision)) addError(errors, "revision", "Expected a positive integer.");
  if (!isNonNegativeInteger(input.updatedAt)) addError(errors, "updatedAt", "Expected a non-negative timestamp.");
  if (!Array.isArray(input.records)) addError(errors, "records", "Expected an array of project profiles.");
  if (Array.isArray(input.records) && !Array.from({ length: input.records.length }, (_, index) => Object.prototype.hasOwnProperty.call(input.records, index)).every(Boolean)) addError(errors, "records", "Sparse profile arrays are not allowed.");
  const ids = new Set<string>();
  let latestProfileUpdate = 0;
  if (Array.isArray(input.records)) {
    input.records.forEach((record, index) => {
      if (validateProfile(record, index, errors)) {
        if (ids.has(record.projectId)) addError(errors, `records[${index}].projectId`, "Duplicate project ID.");
        ids.add(record.projectId);
        latestProfileUpdate = Math.max(latestProfileUpdate, record.updatedAt);
      }
    });
  }
  if (isNonNegativeInteger(input.updatedAt) && input.updatedAt < latestProfileUpdate) addError(errors, "updatedAt", "Store timestamp cannot precede a profile update.");
  // Each profile receives its own node/depth budget in validateProfile; do not
  // apply one aggregate budget to the entire collection.
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as ProjectProfilesStore };
}

/**
 * Additive, pure migration. Existing profiles are never replaced. Invalid
 * legacy entries are reported individually; the legacy source is untouched.
 * The caller must use a stable migration timestamp and persist/read-back safely.
 */
export function migrateLegacyProjectsToProfiles(
  legacyProjects: readonly unknown[],
  migratedAt: number,
  existingStore?: ProjectProfilesStore
): LegacyMigrationResult {
  if (!isNonNegativeInteger(migratedAt)) throw new RangeError("Migration timestamp must be a non-negative integer.");
  let base: ProjectProfilesStore;
  if (existingStore) {
    const checked = validateProjectProfilesStore(existingStore);
    if (!checked.ok) throw new TypeError("Existing profile store is invalid; refusing to overwrite it.");
    base = JSON.parse(JSON.stringify(checked.value)) as ProjectProfilesStore;
  } else {
    base = { schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION, revision: 1, updatedAt: migratedAt, records: [] };
  }
  const ids = new Set(base.records.map((record) => record.projectId));
  const seenLegacyIds = new Set<string>();
  const rejected: LegacyMigrationRejection[] = [];
  if (!Array.isArray(legacyProjects)) throw new TypeError("Legacy projects must be an array.");
  const additions: ProjectProfile[] = [];
  for (let index = 0; index < legacyProjects.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(legacyProjects, index)) {
      rejected.push({ index, reason: "Sparse legacy project entry." });
      continue;
    }
    const candidate = legacyProjects[index];
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.trim().length === 0 ||
      candidate.id.trim() !== candidate.id || dangerousKeys.has(candidate.id)) {
      rejected.push({ index, reason: "Legacy project must have a safe, non-empty string ID." });
      continue;
    }
    const id = candidate.id;
    if (seenLegacyIds.has(id)) { rejected.push({ index, reason: "Duplicate legacy project ID." }); return; }
    seenLegacyIds.add(id);
    if (ids.has(id)) continue;
    let name: string;
    let nameUnknown = false;
    if (typeof candidate.name === "string" && candidate.name.trim().length > 0) name = candidate.name.trim();
    else { name = `Legacy project ${id}`; nameUnknown = true; }
    ids.add(id);
    additions.push({
      projectId: id, profileRevision: 1, createdAt: migratedAt, updatedAt: migratedAt,
      identity: { name, purpose: "" }, lifecycle: "draft",
      repositories: [], websites: [], technology: [], goals: [], governanceReferences: [], workflow: [],
      dataClassification: "unknown", allowedTools: [], forbiddenActions: [], releaseRules: [], risks: [],
      recoveryPlan: [],
      unknownFields: [
        ...(nameUnknown ? ["identity.name"] : []), "purpose", "repositories", "websites", "technology",
        "goals", "governanceReferences", "workflow", "dataClassification", "allowedTools",
        "forbiddenActions", "releaseRules", "risks", "recoveryPlan"
      ],
      approval: {
        status: "unapproved", approvedRevision: null, evidence: null, approvedAt: null,
        approvedContentHash: null, revokedAt: null, revokedRevision: null, revocationReason: null, revocationHistory: []
      }
    });
  }
  if (additions.length === 0) return { store: base, rejected };
  const store: ProjectProfilesStore = {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    revision: base.revision + 1,
    updatedAt: Math.max(migratedAt, base.updatedAt),
    records: [...base.records, ...additions]
  };
  const checked = validateProjectProfilesStore(store);
  if (!checked.ok) throw new TypeError(`Generated profile migration failed validation: ${checked.errors.map((item) => item.path).join(", ")}`);
  return { store: checked.value, rejected };
}
