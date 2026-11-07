import { CUTOVER_INTENT_KEY, STORAGE_KEY, withStorageLock } from "./storage";
import { createProjectProfileStore } from "./profileStore";
import { createTaskLedgerStore } from "./taskLedgerStore";

/**
 * PR-D cutover controller.
 *
 * Coordinates the forward-only lifecycle intent -> profiles-verified -> stores-verified -> committed.
 * The controller never deletes anything and never writes the legacy workspace key. The marker key is
 * the same key the legacy write barrier in storage.ts consults, so any marker bytes block legacy writes.
 * It is not wired to any UI action: nothing in the application can start a cutover yet.
 */
export const CUTOVER_MARKER_KEY = CUTOVER_INTENT_KEY;
export const CUTOVER_SOURCE_COPY_PREFIX = "devmate-cutover-v1:source:";
export const CUTOVER_MARKER_VERSION = 1;
/** Upper bound for a serialized marker; keeps later phase advances inside the space the intent write proved available. */
export const MAX_MARKER_BYTES = 256;
export const CUTOVER_PHASES = ["intent", "profiles-verified", "stores-verified", "committed"] as const;
export type CutoverPhase = (typeof CUTOVER_PHASES)[number];

export type CutoverMarker = {
  version: 1;
  sourceFingerprint: string;
  startedAt: number;
  phase: CutoverPhase;
  profileSchemaVersion: 1;
  ledgerSchemaVersion: 1;
};
const MARKER_KEYS = ["version", "sourceFingerprint", "startedAt", "phase", "profileSchemaVersion", "ledgerSchemaVersion"] as const;

/**
 * Source fingerprint (R2): FNV-1a 32-bit over UTF-16 code units plus the code-unit length, or "absent" when
 * the legacy key does not exist. It is deterministic and non-cryptographic: it detects accidental change only.
 * The proof that the source is unchanged is a full-string comparison with the preserved raw copy.
 */
export function fingerprintSource(raw: string | null): string {
  if (raw === null) return "absent";
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}-${raw.length}`;
}
const FINGERPRINT_PATTERN = /^(?:absent|fnv1a32-[0-9a-f]{8}-\d{1,10})$/;
export const phaseIndex = (phase: CutoverPhase): number => CUTOVER_PHASES.indexOf(phase);
export function serializeMarker(marker: CutoverMarker): string {
  return JSON.stringify({
    version: marker.version, sourceFingerprint: marker.sourceFingerprint, startedAt: marker.startedAt,
    phase: marker.phase, profileSchemaVersion: marker.profileSchemaVersion, ledgerSchemaVersion: marker.ledgerSchemaVersion
  });
}

export type MarkerParse = { ok: true; marker: CutoverMarker } | { ok: false; reason: "malformed"; message: string };
/** Strict validation: exact key set, exact types, known version/phase, and canonical serialization. */
export function parseMarker(raw: string): MarkerParse {
  const bad = (message: string): MarkerParse => ({ ok: false, reason: "malformed", message });
  if (raw.length > MAX_MARKER_BYTES) return bad("The cutover marker is larger than the fixed maximum size.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return bad("The cutover marker is not valid JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("The cutover marker is not an object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== MARKER_KEYS.length || !MARKER_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key)))
    return bad("The cutover marker has missing or unknown fields.");
  if (record.version !== CUTOVER_MARKER_VERSION) return bad("The cutover marker version is unknown.");
  if (record.profileSchemaVersion !== 1 || record.ledgerSchemaVersion !== 1) return bad("The cutover marker store schema versions are unknown.");
  if (typeof record.sourceFingerprint !== "string" || !FINGERPRINT_PATTERN.test(record.sourceFingerprint)) return bad("The cutover marker source fingerprint is invalid.");
  if (typeof record.startedAt !== "number" || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0) return bad("The cutover marker start time is invalid.");
  if (typeof record.phase !== "string" || !(CUTOVER_PHASES as readonly string[]).includes(record.phase)) return bad("The cutover marker phase is unknown.");
  const marker = record as unknown as CutoverMarker;
  if (serializeMarker(marker) !== raw) return bad("The cutover marker is not in canonical form.");
  return { ok: true, marker };
}

type ReadStorage = { getItem(key: string): string | null };
export type CutoverState =
  | { mode: "legacy" }
  | { mode: "recovery"; phase: Exclude<CutoverPhase, "committed">; marker: CutoverMarker }
  | { mode: "durable"; marker: CutoverMarker }
  | { mode: "indeterminate"; reason: "unreadable" | "malformed" | "source-changed" | "source-copy-missing" | "source-unreadable"; message: string; marker?: CutoverMarker };

/** Restart rule: no marker = legacy; intent/intermediate = recovery (read-only); committed = durable; anything else = indeterminate. Never throws. */
export function readCutoverState(storage: ReadStorage | null | undefined): CutoverState {
  if (!storage || typeof storage.getItem !== "function") return { mode: "indeterminate", reason: "unreadable", message: "Browser storage cannot be inspected, so the cutover state is unknown." };
  let raw: string | null;
  try { raw = storage.getItem(CUTOVER_MARKER_KEY); }
  catch (error) { return { mode: "indeterminate", reason: "unreadable", message: `The cutover marker could not be read: ${describe(error)}` }; }
  if (raw === null) return { mode: "legacy" };
  const parsed = parseMarker(raw);
  if (!parsed.ok) return { mode: "indeterminate", reason: "malformed", message: parsed.message };
  return parsed.marker.phase === "committed"
    ? { mode: "durable", marker: parsed.marker }
    : { mode: "recovery", phase: parsed.marker.phase, marker: parsed.marker };
}

export type StageResult = { ok: true } | { ok: false; reason: string; message: string };
/** Stage work runs INSIDE the controller's shared lock; implementations must not take the lock again. */
export type CutoverStages = {
  migrateProfiles(): Promise<StageResult>;
  verifyProfiles(): Promise<StageResult>;
  verifyStores(): Promise<StageResult>;
  /** Optional: reports whether any durable profile/ledger state already exists (used only for abort eligibility). */
  hasDurableState?(): Promise<boolean>;
};
type ControllerStorage = Pick<Storage, "getItem" | "setItem">;
type LockRunner = <R>(work: () => R | Promise<R>) => Promise<
  { ok: true; value: R } | { ok: false; reason: "lock-unavailable" | "lock-timeout" | "lock-error"; message: string }
>;
export type CutoverControllerOptions = {
  storage?: ControllerStorage | null;
  stages: CutoverStages;
  now?: () => number;
  runExclusive?: LockRunner;
  /** Host-owned proof that every pre-barrier application instance has been closed or reloaded. Missing/false means no intent marker may be written. Must not acquire the storage lock. */
  confirmLegacyWritersQuiesced?: () => boolean | Promise<boolean>;
};

export type CutoverFailureReason =
  | "lock-unavailable" | "lock-timeout" | "lock-error" | "storage-unavailable"
  | "marker-present" | "no-marker" | "marker-invalid" | "marker-changed" | "marker-write-failed" | "marker-verify-failed"
  | "stale-plan" | "source-unreadable" | "source-changed" | "source-copy-missing"
  | "preserve-failed" | "preserve-conflict" | "preserve-quota" | "stage-failed" | "legacy-writers-not-quiesced";
export type CutoverResult =
  | { ok: true; state: CutoverState; changed: boolean }
  | { ok: false; reason: CutoverFailureReason; message: string; state: CutoverState; stageReason?: string; divergentPreserved?: boolean };
export type CutoverPlan = { sourceRaw: string | null; fingerprint: string };
export type PreflightResult = { ok: true; plan: CutoverPlan } | { ok: false; reason: CutoverFailureReason; message: string; state: CutoverState };
export type AbortEligibility = { eligible: boolean; checks: { name: string; ok: boolean; detail: string }[] };
export type SourceExport = { ok: true; raw: string | null; fingerprint: string; markerRaw: string } | { ok: false; reason: CutoverFailureReason; message: string };

function describe(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }
function isQuota(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; code?: unknown };
  return e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014;
}
const copyKey = (fingerprint: string) => `${CUTOVER_SOURCE_COPY_PREFIX}${fingerprint}`;

export function createCutoverController(options: CutoverControllerOptions) {
  const storage = options.storage === undefined
    ? (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })()
    : options.storage;
  const now = options.now ?? Date.now;
  const runExclusive: LockRunner = options.runExclusive ?? ((work) => withStorageLock(work));
  const stages = options.stages;

  const readSource = (): { ok: true; raw: string | null } | { ok: false; message: string } => {
    try { return { ok: true, raw: storage!.getItem(STORAGE_KEY) }; }
    catch (error) { return { ok: false, message: describe(error) }; }
  };
  /** Idempotent, non-overwriting preservation keyed by fingerprint (R3). An exact existing copy is success. */
  const preserve = (raw: string | null): { ok: true } | { ok: false; reason: "preserve-failed" | "preserve-conflict" | "preserve-quota"; message: string } => {
    if (raw === null) return { ok: true };
    const key = copyKey(fingerprintSource(raw));
    try {
      const existing = storage!.getItem(key);
      if (existing === raw) return { ok: true };
      if (existing !== null) return { ok: false, reason: "preserve-conflict", message: "A different preserved copy already uses this fingerprint; it was not overwritten." };
      storage!.setItem(key, raw);
      if (storage!.getItem(key) !== raw) return { ok: false, reason: "preserve-failed", message: "The preserved raw copy could not be verified byte for byte." };
      return { ok: true };
    } catch (error) {
      return isQuota(error)
        ? { ok: false, reason: "preserve-quota", message: "Browser storage is full; the raw legacy copy was not preserved." }
        : { ok: false, reason: "preserve-failed", message: `The raw legacy copy could not be preserved: ${describe(error)}` };
    }
  };
  /** R1/R2: current legacy bytes must equal the preserved copy (or both be absent) AND the marker fingerprint. */
  const checkSource = (marker: CutoverMarker): { ok: true } | { ok: false; reason: "source-unreadable" | "source-changed" | "source-copy-missing"; message: string; currentRaw?: string | null } => {
    const current = readSource();
    if (!current.ok) return { ok: false, reason: "source-unreadable", message: `The legacy source could not be read: ${current.message}` };
    if (fingerprintSource(current.raw) !== marker.sourceFingerprint)
      return { ok: false, reason: "source-changed", message: "The legacy workspace changed after cutover intent; it was not advanced.", currentRaw: current.raw };
    if (marker.sourceFingerprint === "absent") return { ok: true };
    let copy: string | null;
    try { copy = storage!.getItem(copyKey(marker.sourceFingerprint)); }
    catch (error) { return { ok: false, reason: "source-unreadable", message: `The preserved raw copy could not be read: ${describe(error)}` }; }
    if (copy === null) return { ok: false, reason: "source-copy-missing", message: "The preserved raw legacy copy is missing." };
    if (copy !== current.raw) return { ok: false, reason: "source-changed", message: "The legacy workspace differs from the preserved raw copy.", currentRaw: current.raw };
    return { ok: true };
  };
  /** Writes the marker and proves the exact bytes; on any failure reports the state actually stored. Never removes a marker. */
  const writeMarker = (marker: CutoverMarker): { ok: true } | { ok: false; reason: "marker-write-failed" | "marker-verify-failed"; message: string } => {
    const serialized = serializeMarker(marker);
    try { storage!.setItem(CUTOVER_MARKER_KEY, serialized); }
    catch (error) { return { ok: false, reason: "marker-write-failed", message: `The cutover marker could not be written: ${describe(error)}` }; }
    try {
      if (storage!.getItem(CUTOVER_MARKER_KEY) !== serialized) return { ok: false, reason: "marker-verify-failed", message: "The cutover marker could not be read back exactly." };
    } catch (error) { return { ok: false, reason: "marker-verify-failed", message: `The cutover marker could not be verified: ${describe(error)}` }; }
    return { ok: true };
  };
  const fail = (reason: CutoverFailureReason, message: string, extra: Partial<Extract<CutoverResult, { ok: false }>> = {}): Extract<CutoverResult, { ok: false }> =>
    ({ ok: false, reason, message, state: readCutoverState(storage), ...extra });
  const locked = async (work: () => CutoverResult | Promise<CutoverResult>): Promise<CutoverResult> => {
    if (!storage) return fail("storage-unavailable", "Browser storage is unavailable.");
    const result = await runExclusive(work);
    return result.ok ? result.value : fail(result.reason, result.message);
  };

  /** Read-only. Deterministic after restart: a marker plus a changed/missing source is reported as indeterminate. */
  function inspect(): CutoverState {
    const state = readCutoverState(storage);
    if (state.mode !== "recovery" && state.mode !== "durable") return state;
    const source = checkSource(state.marker);
    if (source.ok) return state;
    return { mode: "indeterminate", reason: source.reason, message: source.message, marker: state.marker };
  }
  /** Read-only plan: exact source bytes and fingerprint. Refuses when any marker already exists. */
  function preflight(): PreflightResult {
    if (!storage) return { ok: false, reason: "storage-unavailable", message: "Browser storage is unavailable.", state: readCutoverState(storage) };
    const state = readCutoverState(storage);
    if (state.mode !== "legacy") return { ok: false, reason: "marker-present", message: "A cutover marker already exists; inspect recovery state instead.", state };
    const source = readSource();
    if (!source.ok) return { ok: false, reason: "source-unreadable", message: `The legacy source could not be read: ${source.message}`, state };
    return { ok: true, plan: { sourceRaw: source.raw, fingerprint: fingerprintSource(source.raw) } };
  }

  /** Declare intent: preserve raw bytes, then write and verify the intent marker. Idempotent for the same source. */
  function begin(plan: CutoverPlan): Promise<CutoverResult> {
    return locked(async () => {
      // A marker only constrains bundles that know to check it. An already-loaded pre-barrier bundle
      // can still call the old mutators, so the controller must not declare intent without a host
      // verifier that has quiesced every legacy writer. There is deliberately no permissive default.
      let quiesced = false;
      try { quiesced = (await options.confirmLegacyWritersQuiesced?.()) === true; } catch { quiesced = false; }
      if (!quiesced) return fail("legacy-writers-not-quiesced", "Cutover is blocked: the host has not proved that every pre-barrier application instance is closed or reloaded. No marker or migration was written.");
      let markerRaw: string | null;
      try { markerRaw = storage!.getItem(CUTOVER_MARKER_KEY); }
      catch (error) { return fail("marker-invalid", `The cutover marker could not be read: ${describe(error)}`); }
      if (markerRaw !== null) {
        const parsed = parseMarker(markerRaw);
        if (!parsed.ok) return fail("marker-invalid", parsed.message);
        const sameSource = parsed.marker.sourceFingerprint === plan.fingerprint && checkSource(parsed.marker).ok;
        if (sameSource) return { ok: true, state: readCutoverState(storage), changed: false };
        return fail("marker-present", "A cutover marker for a different or changed source already exists; nothing was changed.");
      }
      const source = readSource();
      if (!source.ok) return fail("source-unreadable", `The legacy source could not be read: ${source.message}`);
      if (source.raw !== plan.sourceRaw || fingerprintSource(source.raw) !== plan.fingerprint)
        return fail("stale-plan", "The legacy workspace changed after preflight; the stale plan was aborted and nothing was written.");
      const kept = preserve(source.raw);
      if (!kept.ok) return fail(kept.reason, kept.message);
      const written = writeMarker({
        version: 1, sourceFingerprint: plan.fingerprint, startedAt: now(), phase: "intent", profileSchemaVersion: 1, ledgerSchemaVersion: 1
      });
      if (!written.ok) return fail(written.reason, written.message);
      return { ok: true, state: readCutoverState(storage), changed: true };
    });
  }

  /** Advance exactly one phase, forward only, after revalidating the marker and the legacy source (R1). */
  function advance(): Promise<CutoverResult> {
    return locked(async () => {
      let markerRaw: string | null;
      try { markerRaw = storage!.getItem(CUTOVER_MARKER_KEY); }
      catch (error) { return fail("marker-invalid", `The cutover marker could not be read: ${describe(error)}`); }
      if (markerRaw === null) return fail("no-marker", "No cutover marker exists; run preflight and declare intent first.");
      const parsed = parseMarker(markerRaw);
      if (!parsed.ok) return fail("marker-invalid", parsed.message);
      const marker = parsed.marker;
      if (marker.phase === "committed") {
        const still = checkSource(marker);
        if (!still.ok) return divergence(still);
        return { ok: true, state: readCutoverState(storage), changed: false };
      }
      const before = checkSource(marker);
      if (!before.ok) return divergence(before);
      let stage: StageResult;
      try {
        if (marker.phase === "intent") {
          stage = await stages.migrateProfiles();
          if (stage.ok) stage = await stages.verifyProfiles();
        } else stage = await stages.verifyStores();
      } catch (error) { stage = { ok: false, reason: "threw", message: describe(error) }; }
      if (!stage.ok) return fail("stage-failed", stage.message, { stageReason: stage.reason });
      // Stage work is asynchronous: revalidate marker bytes and source again immediately before the write.
      let currentMarkerRaw: string | null;
      try { currentMarkerRaw = storage!.getItem(CUTOVER_MARKER_KEY); }
      catch (error) { return fail("marker-invalid", `The cutover marker could not be read: ${describe(error)}`); }
      if (currentMarkerRaw !== markerRaw) return fail("marker-changed", "The cutover marker changed while the stage ran; nothing was advanced.");
      const after = checkSource(marker);
      if (!after.ok) return divergence(after);
      const next = CUTOVER_PHASES[phaseIndex(marker.phase) + 1];
      const written = writeMarker({ ...marker, phase: next });
      if (!written.ok) return fail(written.reason, written.message);
      return { ok: true, state: readCutoverState(storage), changed: true };
    });
  }
  function divergence(check: Extract<ReturnType<typeof checkSource>, { ok: false }>): Extract<CutoverResult, { ok: false }> {
    let divergentPreserved: boolean | undefined;
    if (check.reason === "source-changed" && check.currentRaw !== undefined) divergentPreserved = preserve(check.currentRaw).ok;
    const state: CutoverState = { mode: "indeterminate", reason: check.reason, message: check.message };
    return { ok: false, reason: check.reason, message: check.message, state, ...(divergentPreserved === undefined ? {} : { divergentPreserved }) };
  }

  /** Forward-only resume: repeats advance() until committed or the first failure. Deterministic and idempotent. */
  async function resume(): Promise<CutoverResult> {
    let last: CutoverResult = { ok: true, state: readCutoverState(storage), changed: false };
    let changed = false;
    for (let step = 0; step < CUTOVER_PHASES.length; step++) {
      last = await advance();
      if (!last.ok) return last;
      changed = changed || last.changed;
      if (last.state.mode === "durable") break;
    }
    return { ok: true, state: last.state, changed };
  }

  /** R4: read-only report. The application never deletes the marker; abort is an owner-run, externally verified procedure. */
  async function verifyAbortEligibility(): Promise<AbortEligibility> {
    const checks: AbortEligibility["checks"] = [];
    const state = readCutoverState(storage);
    checks.push({ name: "marker-valid-intent", ok: state.mode === "recovery" && state.phase === "intent", detail: `mode=${state.mode}` });
    if (state.mode === "recovery") {
      const source = checkSource(state.marker);
      checks.push({ name: "source-unchanged-byte-for-byte", ok: source.ok, detail: source.ok ? "legacy bytes equal the preserved copy" : source.message });
    } else checks.push({ name: "source-unchanged-byte-for-byte", ok: false, detail: "no valid intermediate marker" });
    let durable: boolean | null = null;
    try { durable = stages.hasDurableState ? await stages.hasDurableState() : null; } catch { durable = null; }
    checks.push({ name: "no-durable-state-committed", ok: durable === false, detail: durable === null ? "cannot be proven" : durable ? "durable state exists" : "no durable state" });
    return { eligible: checks.every((check) => check.ok), checks };
  }

  /** R5 primitive: byte-preserving export of the preserved source. No release/prune operation exists in the app. */
  function exportPreservedSource(): SourceExport {
    if (!storage) return { ok: false, reason: "storage-unavailable", message: "Browser storage is unavailable." };
    let markerRaw: string | null;
    try { markerRaw = storage.getItem(CUTOVER_MARKER_KEY); } catch (error) { return { ok: false, reason: "marker-invalid", message: describe(error) }; }
    if (markerRaw === null) return { ok: false, reason: "no-marker", message: "No cutover marker exists." };
    const parsed = parseMarker(markerRaw);
    if (!parsed.ok) return { ok: false, reason: "marker-invalid", message: parsed.message };
    if (parsed.marker.sourceFingerprint === "absent") return { ok: true, raw: null, fingerprint: "absent", markerRaw };
    let copy: string | null;
    try { copy = storage.getItem(copyKey(parsed.marker.sourceFingerprint)); } catch (error) { return { ok: false, reason: "source-unreadable", message: describe(error) }; }
    if (copy === null) return { ok: false, reason: "source-copy-missing", message: "The preserved raw copy is missing." };
    return { ok: true, raw: copy, fingerprint: parsed.marker.sourceFingerprint, markerRaw };
  }

  return { inspect, preflight, begin, advance, resume, verifyAbortEligibility, exportPreservedSource };
}

/**
 * Production stage wiring over the PR-B/PR-C adapters. The stores receive a pass-through lock runner because the
 * controller already holds the single shared Web Lock (nested requests on that lock would deadlock).
 */
export function createCutoverStages(options: { storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null; now?: () => number } = {}): CutoverStages {
  const storage = options.storage === undefined
    ? (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })()
    : options.storage;
  const passThrough: LockRunner = async (work) => {
    try { return { ok: true, value: await work() }; }
    catch (error) { return { ok: false, reason: "lock-error", message: describe(error) }; }
  };
  const shared = { storage, runExclusive: passThrough, ...(options.now ? { now: options.now } : {}) };
  const profiles = createProjectProfileStore(shared);
  const ledgers = createTaskLedgerStore(shared);
  const legacyProjectIds = (): { ok: true; ids: string[] } | { ok: false; message: string } => {
    try {
      const raw = storage?.getItem(STORAGE_KEY) ?? null;
      if (raw === null) return { ok: true, ids: [] };
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { ok: false, message: "The legacy workspace is not a project array." };
      const ids = parsed.map((item) => (typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined));
      if (!ids.every((id): id is string => typeof id === "string" && id.length > 0)) return { ok: false, message: "A legacy project has no valid id." };
      return { ok: true, ids: ids as string[] };
    } catch (error) { return { ok: false, message: describe(error) }; }
  };
  const verifyProfiles = async (): Promise<StageResult> => {
    if ((await profiles.migrationStatus()) !== "migrated") return { ok: false, reason: "not-migrated", message: "The profile migration marker is not verified." };
    const legacy = legacyProjectIds();
    if (!legacy.ok) return { ok: false, reason: "legacy-unreadable", message: legacy.message };
    for (const id of legacy.ids) {
      const read = await profiles.readProfile(id);
      if (!read.ok) return { ok: false, reason: read.reason, message: read.message };
      if (read.status !== "found" || read.value.projectId !== id) return { ok: false, reason: "profile-missing", message: `Project ${id} has no matching profile.` };
    }
    return { ok: true };
  };
  return {
    async migrateProfiles() {
      const result = await profiles.migrateLegacyProfiles();
      return result.ok ? { ok: true } : { ok: false, reason: result.reason, message: result.message };
    },
    verifyProfiles,
    async verifyStores() {
      const base = await verifyProfiles();
      if (!base.ok) return base;
      const legacy = legacyProjectIds();
      if (!legacy.ok) return { ok: false, reason: "legacy-unreadable", message: legacy.message };
      for (const id of legacy.ids) {
        const ledger = await ledgers.readLedger(id);
        if (!ledger.ok) return { ok: false, reason: ledger.reason, message: ledger.message };
      }
      return { ok: true };
    },
    async hasDurableState() {
      const status = await profiles.migrationStatus();
      return status !== "never-migrated";
    }
  };
}
