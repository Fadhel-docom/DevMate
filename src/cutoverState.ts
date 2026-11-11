import { CUTOVER_INTENT_KEY, STORAGE_KEY } from "./storage";

/**
 * Read-only cutover state (PR #32 repair, R1 narrowing).
 *
 * This module is the ONLY cutover code the production application imports. It contains no function that
 * writes a marker, advances a phase, migrates data or removes anything. A real host-level fence against
 * already-loaded pre-barrier bundles cannot be built inside a client-only, same-origin localStorage
 * architecture (see docs/PR-D-REVIEW-LEDGER.md, R1 disposition), so the mutating controller lives in
 * cutoverController.ts and is deliberately unreachable from src/main.tsx (enforced by productionIsolation.test.ts).
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


export function describe(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }
export const copyKey = (fingerprint: string) => `${CUTOVER_SOURCE_COPY_PREFIX}${fingerprint}`;

export type SourceCheck =
  | { ok: true }
  | { ok: false; reason: "source-unreadable" | "source-changed" | "source-copy-missing"; message: string; currentRaw?: string | null };
/** R1/R2: current legacy bytes must equal the preserved copy (or both be absent) AND the marker fingerprint. Read-only. */
export function checkSourceMatch(storage: ReadStorage, marker: CutoverMarker): SourceCheck {
  let currentRaw: string | null;
  try { currentRaw = storage.getItem(STORAGE_KEY); }
  catch (error) { return { ok: false, reason: "source-unreadable", message: `The legacy source could not be read: ${describe(error)}` }; }
  if (fingerprintSource(currentRaw) !== marker.sourceFingerprint)
    return { ok: false, reason: "source-changed", message: "The legacy workspace changed after cutover intent; it was not advanced.", currentRaw };
  if (marker.sourceFingerprint === "absent") return { ok: true };
  let copy: string | null;
  try { copy = storage.getItem(copyKey(marker.sourceFingerprint)); }
  catch (error) { return { ok: false, reason: "source-unreadable", message: `The preserved raw copy could not be read: ${describe(error)}` }; }
  if (copy === null) return { ok: false, reason: "source-copy-missing", message: "The preserved raw legacy copy is missing." };
  if (copy !== currentRaw) return { ok: false, reason: "source-changed", message: "The legacy workspace differs from the preserved raw copy.", currentRaw };
  return { ok: true };
}

/** Read-only. Deterministic after restart: a marker plus a changed/missing source is reported as indeterminate. */
export function inspectCutoverState(storage: ReadStorage | null | undefined): CutoverState {
  const state = readCutoverState(storage);
  if (state.mode !== "recovery" && state.mode !== "durable") return state;
  const source = checkSourceMatch(storage!, state.marker);
  if (source.ok) return state;
  return { mode: "indeterminate", reason: source.reason, message: source.message, marker: state.marker };
}

export type SourceExportFailure = "storage-unavailable" | "no-marker" | "marker-invalid" | "source-unreadable" | "source-copy-missing";
export type SourceExport = { ok: true; raw: string | null; fingerprint: string; markerRaw: string } | { ok: false; reason: SourceExportFailure; message: string };
/** Byte-preserving read of the raw copy the marker refers to. Never writes. No release/prune operation exists in the app. */
export function readPreservedSource(storage: ReadStorage | null | undefined): SourceExport {
  if (!storage || typeof storage.getItem !== "function") return { ok: false, reason: "storage-unavailable", message: "Browser storage is unavailable." };
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
