import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CUTOVER_MARKER_KEY, CUTOVER_PHASES, CUTOVER_SOURCE_COPY_PREFIX, MAX_MARKER_BYTES,
  createCutoverController, createCutoverStages, fingerprintSource, parseMarker, readCutoverState, serializeMarker,
  type CutoverMarker, type CutoverPhase, type CutoverStages, type StageResult
} from "./cutoverController";
import { BACKUP_KEY, STORAGE_KEY, deleteBackup, listBackups, readProjects, restoreBackup, saveProjects, saveProjectsLocked } from "./storage";
import { durableBackupKey, durableStoreKey } from "./durableStore";

/** In-memory storage that records every write/removal and can inject failures. Never touches the real localStorage. */
class MemStorage {
  values = new Map<string, string>();
  sets: string[] = [];
  removed: string[] = [];
  failSet: ((key: string, value: string) => Error | null) | null = null;
  failGet: ((key: string) => Error | null) | null = null;
  corruptReadback: ((key: string) => boolean) | null = null;
  corruptReadAfterSet: ((key: string) => boolean) | null = null;
  private pendingCorrupt: string | null = null;
  getItem = (key: string): string | null => {
    const error = this.failGet?.(key); if (error) throw error;
    const value = this.values.get(key) ?? null;
    if (value !== null && this.pendingCorrupt === key) { this.pendingCorrupt = null; return `${value} `; }
    return value !== null && this.corruptReadback?.(key) ? `${value} ` : value;
  };
  setItem = (key: string, value: string): void => {
    const error = this.failSet?.(key, value); if (error) throw error;
    this.sets.push(key); this.values.set(key, value);
    if (this.corruptReadAfterSet?.(key)) this.pendingCorrupt = key;
  };
  removeItem = (key: string): void => { this.removed.push(key); this.values.delete(key); };
}
const domError = (name: string, code = 0) => { const e = new Error(name); e.name = name; (e as Error & { code: number }).code = code; return e; };
function mutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return async <R>(work: () => R | Promise<R>) => {
    const run = chain.then(() => work());
    chain = run.then(() => undefined, () => undefined);
    return { ok: true as const, value: await run };
  };
}
function installFakeLocks() {
  const chains = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request(name: string, _opts: unknown, cb: () => Promise<unknown>) {
      const prev = chains.get(name) ?? Promise.resolve();
      const next = prev.then(() => cb());
      chains.set(name, next.catch(() => undefined));
      return next;
    }
  } });
}
function uninstallLocks() { delete (navigator as unknown as { locks?: unknown }).locks; }

const LEGACY = JSON.stringify([
  { id: "p1", name: "Project one", tasks: [{ id: "t1", title: "Legacy task", done: true, createdAt: 1700000000000 }] },
  { id: "p2", name: "Project two", tasks: [] }
]);
const NOW = 1_800_000_000_000;
const copyKeyFor = (raw: string) => `${CUTOVER_SOURCE_COPY_PREFIX}${fingerprintSource(raw)}`;

type StageLog = { calls: string[]; hooks: Partial<Record<"migrateProfiles" | "verifyProfiles" | "verifyStores", () => StageResult | Promise<StageResult> | void>> };
function fakeStages(log: StageLog, durable = false): CutoverStages {
  const run = async (name: keyof StageLog["hooks"]): Promise<StageResult> => {
    log.calls.push(name);
    const out = await log.hooks[name]?.();
    return out ?? { ok: true };
  };
  return {
    migrateProfiles: () => run("migrateProfiles"),
    verifyProfiles: () => run("verifyProfiles"),
    verifyStores: () => run("verifyStores"),
    hasDurableState: async () => durable
  };
}
function setup(raw: string | null = LEGACY) {
  const storage = new MemStorage();
  if (raw !== null) storage.values.set(STORAGE_KEY, raw);
  const log: StageLog = { calls: [], hooks: {} };
  const lock = mutex();
  const make = () => createCutoverController({ storage, stages: fakeStages(log), now: () => NOW, runExclusive: lock, confirmLegacyWritersQuiesced: async () => true });
  return { storage, log, lock, make, controller: make() };
}
async function begun(raw: string | null = LEGACY) {
  const ctx = setup(raw);
  const plan = ctx.controller.preflight();
  if (!plan.ok) throw new Error("preflight failed");
  const result = await ctx.controller.begin(plan.plan);
  expect(result.ok).toBe(true);
  ctx.storage.sets.length = 0; ctx.log.calls.length = 0;
  return ctx;
}
async function toPhase(ctx: Awaited<ReturnType<typeof begun>>, phase: CutoverPhase) {
  for (let i = 0; i < CUTOVER_PHASES.indexOf(phase); i++) expect((await ctx.controller.advance()).ok).toBe(true);
  expect(readCutoverState(ctx.storage)).toMatchObject({ marker: { phase } });
  ctx.storage.sets.length = 0; ctx.log.calls.length = 0;
}
const marker = (overrides: Partial<CutoverMarker> = {}): CutoverMarker => ({
  version: 1, sourceFingerprint: fingerprintSource(LEGACY), startedAt: NOW, phase: "intent", profileSchemaVersion: 1, ledgerSchemaVersion: 1, ...overrides
});

describe("marker schema (R2, R6)", () => {
  it("fingerprints deterministically, distinguishes absent from empty, and includes the length", () => {
    expect(fingerprintSource(LEGACY)).toBe(fingerprintSource(LEGACY));
    expect(fingerprintSource(null)).toBe("absent");
    expect(fingerprintSource("")).not.toBe(fingerprintSource(null));
    expect(fingerprintSource("a")).not.toBe(fingerprintSource("b"));
    expect(fingerprintSource(LEGACY)).toMatch(/^fnv1a32-[0-9a-f]{8}-\d+$/);
  });
  it.each(CUTOVER_PHASES)("round-trips a canonical marker in phase %s and stays under the fixed size bound", (phase) => {
    const raw = serializeMarker(marker({ phase }));
    expect(raw.length).toBeLessThanOrEqual(MAX_MARKER_BYTES);
    expect(parseMarker(raw)).toEqual({ ok: true, marker: marker({ phase }) });
  });
  it("keeps the worst-case marker (longest fingerprint and phase) within the size bound", () => {
    const worst = marker({ phase: "profiles-verified", sourceFingerprint: `fnv1a32-ffffffff-${"9".repeat(10)}`, startedAt: Number.MAX_SAFE_INTEGER });
    expect(serializeMarker(worst).length).toBeLessThanOrEqual(MAX_MARKER_BYTES);
  });
  const good = serializeMarker(marker());
  const mutate = (fn: (o: Record<string, unknown>) => void) => { const o = JSON.parse(good) as Record<string, unknown>; fn(o); return JSON.stringify(o); };
  it.each([
    ["empty string", ""], ["not JSON", "{"], ["null", "null"], ["array", "[]"], ["number", "1"],
    ["extra field", mutate((o) => { o.extra = 1; })], ["missing field", mutate((o) => { delete o.phase; })],
    ["unknown phase", mutate((o) => { o.phase = "done"; })], ["unknown version", mutate((o) => { o.version = 2; })],
    ["bad schema version", mutate((o) => { o.ledgerSchemaVersion = 2; })], ["bad fingerprint", mutate((o) => { o.sourceFingerprint = "abc"; })],
    ["negative start", mutate((o) => { o.startedAt = -1; })], ["fractional start", mutate((o) => { o.startedAt = 1.5; })],
    ["string start", mutate((o) => { o.startedAt = "1"; })], ["non-canonical whitespace", ` ${good}`], ["oversized", `${good}${" ".repeat(MAX_MARKER_BYTES)}`],
    ["reordered keys", JSON.stringify({ phase: "intent", ...JSON.parse(good) })]
  ])("rejects a malformed marker: %s", (_name, raw) => {
    expect(parseMarker(raw).ok).toBe(false);
    const storage = new MemStorage(); storage.values.set(CUTOVER_MARKER_KEY, raw);
    expect(readCutoverState(storage)).toMatchObject({ mode: "indeterminate", reason: "malformed" });
  });
});

  it("fails closed before intent unless a host proves every pre-barrier writer is quiesced", async () => {
    const storage = new MemStorage(); storage.values.set(STORAGE_KEY, LEGACY);
    const controller = createCutoverController({ storage, stages: fakeStages({ calls: [], hooks: {} }) });
    const plan = controller.preflight(); if (!plan.ok) throw new Error("preflight failed");
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: false, reason: "legacy-writers-not-quiesced", state: { mode: "legacy" } });
    expect(storage.sets).toEqual([]);
    expect(storage.values.has(CUTOVER_MARKER_KEY)).toBe(false);
    // A pre-barrier bundle has no marker check and can still write; therefore the safe outcome is
    // to keep cutover unstarted until a real host-level quiescence verifier exists.
    storage.setItem(STORAGE_KEY, "[]");
    expect(readCutoverState(storage)).toEqual({ mode: "legacy" });
  });

describe("restart rule: readCutoverState", () => {
  it("maps no marker to legacy, intent/intermediate to recovery, committed to durable", () => {
    const storage = new MemStorage();
    expect(readCutoverState(storage)).toEqual({ mode: "legacy" });
    for (const phase of CUTOVER_PHASES) {
      storage.values.set(CUTOVER_MARKER_KEY, serializeMarker(marker({ phase })));
      const state = readCutoverState(storage);
      expect(state.mode).toBe(phase === "committed" ? "durable" : "recovery");
    }
  });
  it("treats an unreadable marker, missing storage and a future version as indeterminate, never legacy", () => {
    const storage = new MemStorage(); storage.failGet = () => domError("SecurityError");
    expect(readCutoverState(storage)).toMatchObject({ mode: "indeterminate", reason: "unreadable" });
    expect(readCutoverState(null)).toMatchObject({ mode: "indeterminate", reason: "unreadable" });
    const future = new MemStorage(); future.values.set(CUTOVER_MARKER_KEY, JSON.stringify({ ...marker(), version: 2 }));
    expect(readCutoverState(future)).toMatchObject({ mode: "indeterminate", reason: "malformed" });
  });
});

describe("preflight and intent (begin)", () => {
  it("preflight is read-only and returns the exact source bytes", () => {
    const { storage, controller } = setup();
    const result = controller.preflight();
    expect(result).toMatchObject({ ok: true, plan: { sourceRaw: LEGACY, fingerprint: fingerprintSource(LEGACY) } });
    expect(storage.sets).toEqual([]);
  });
  it("preserves raw bytes first, then writes the verified intent marker, and never touches the legacy key", async () => {
    const { storage, controller } = setup();
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    const result = await controller.begin(plan.plan);
    expect(result).toMatchObject({ ok: true, changed: true, state: { mode: "recovery", phase: "intent" } });
    expect(storage.sets).toEqual([copyKeyFor(LEGACY), CUTOVER_MARKER_KEY]);
    expect(storage.values.get(copyKeyFor(LEGACY))).toBe(LEGACY);
    expect(storage.values.get(STORAGE_KEY)).toBe(LEGACY);
    expect(storage.removed).toEqual([]);
    expect(readCutoverState(storage)).toMatchObject({ marker: { startedAt: NOW, sourceFingerprint: fingerprintSource(LEGACY) } });
  });
  it("is idempotent when intent was already declared for the same source", async () => {
    const ctx = await begun();
    const plan = { sourceRaw: LEGACY, fingerprint: fingerprintSource(LEGACY) };
    expect(await ctx.controller.begin(plan)).toMatchObject({ ok: true, changed: false });
    expect(ctx.storage.sets).toEqual([]);
  });
  it("aborts a stale plan when the source changed between preflight and lock acquisition (R1)", async () => {
    const { storage, controller } = setup();
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    storage.values.set(STORAGE_KEY, `${LEGACY.slice(0, -1)},{"id":"p3","name":"late","tasks":[]}]`);
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: false, reason: "stale-plan", state: { mode: "legacy" } });
    expect(storage.sets).toEqual([]);
  });
  it("a stale tab's plan cannot override intent declared by another tab for different bytes", async () => {
    const a = setup(); const planA = a.controller.preflight(); if (!planA.ok) throw new Error("x");
    expect((await a.controller.begin(planA.plan)).ok).toBe(true);
    const staleTab = createCutoverController({ storage: a.storage, stages: fakeStages(a.log), now: () => NOW, runExclusive: a.lock, confirmLegacyWritersQuiesced: async () => true });
    const stalePlan = { sourceRaw: "[]", fingerprint: fingerprintSource("[]") };
    expect(await staleTab.begin(stalePlan)).toMatchObject({ ok: false, reason: "marker-present" });
    expect(a.controller.preflight()).toMatchObject({ ok: false, reason: "marker-present" });
  });
  it("retries safely after a crash between raw preservation and the marker write (R3)", async () => {
    const { storage, controller } = setup();
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    storage.failSet = (key) => (key === CUTOVER_MARKER_KEY ? domError("QuotaExceededError", 22) : null);
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: false, reason: "marker-write-failed", state: { mode: "legacy" } });
    expect(storage.sets).toEqual([copyKeyFor(LEGACY)]);
    storage.failSet = null;
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: true, changed: true });
    expect(storage.sets.filter((key) => key === copyKeyFor(LEGACY))).toHaveLength(1);
  });
  it("refuses to overwrite a conflicting preserved copy", async () => {
    const { storage, controller } = setup();
    storage.values.set(copyKeyFor(LEGACY), "different bytes");
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: false, reason: "preserve-conflict" });
    expect(storage.values.get(copyKeyFor(LEGACY))).toBe("different bytes");
    expect(storage.values.has(CUTOVER_MARKER_KEY)).toBe(false);
  });
  it("reports quota exhaustion while preserving and writes no marker", async () => {
    const { storage, controller } = setup();
    storage.failSet = (key) => (key.startsWith(CUTOVER_SOURCE_COPY_PREFIX) ? domError("QuotaExceededError", 22) : null);
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: false, reason: "preserve-quota", state: { mode: "legacy" } });
    expect(storage.values.get(STORAGE_KEY)).toBe(LEGACY);
  });
  it("fails when the preserved copy cannot be verified byte for byte", async () => {
    const { storage, controller } = setup();
    storage.corruptReadback = (key) => key.startsWith(CUTOVER_SOURCE_COPY_PREFIX);
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: false, reason: "preserve-failed" });
    expect(storage.values.has(CUTOVER_MARKER_KEY)).toBe(false);
  });
  it("enters read-only indeterminate state when marker bytes exist but cannot be verified", async () => {
    const { storage, controller } = setup();
    storage.corruptReadback = (key) => key === CUTOVER_MARKER_KEY;
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    const result = await controller.begin(plan.plan);
    expect(result).toMatchObject({ ok: false, reason: "marker-verify-failed", state: { mode: "indeterminate" } });
    expect(storage.values.has(CUTOVER_MARKER_KEY)).toBe(true);
    expect(saveProjects([{ id: "x", name: "x", tasks: [] }], storage)).toMatchObject({ ok: false });
  });
  it("handles a missing legacy workspace (absent) and an empty one (\"\") as different sources", async () => {
    const absent = setup(null); const planA = absent.controller.preflight(); if (!planA.ok) throw new Error("x");
    expect(await absent.controller.begin(planA.plan)).toMatchObject({ ok: true, state: { marker: { sourceFingerprint: "absent" } } });
    expect(absent.storage.sets).toEqual([CUTOVER_MARKER_KEY]);
    const empty = setup(""); const planE = empty.controller.preflight(); if (!planE.ok) throw new Error("x");
    expect(planE.plan.fingerprint).not.toBe("absent");
    expect(await empty.controller.begin(planE.plan)).toMatchObject({ ok: true });
    expect(empty.storage.values.get(copyKeyFor(""))).toBe("");
  });
  it("reports an unreadable legacy source and unavailable storage without writing", async () => {
    const { storage, controller } = setup();
    storage.failGet = (key) => (key === STORAGE_KEY ? domError("SecurityError") : null);
    expect(controller.preflight()).toMatchObject({ ok: false, reason: "source-unreadable" });
    const none = createCutoverController({ storage: null, stages: fakeStages({ calls: [], hooks: {} }) });
    expect(none.preflight()).toMatchObject({ ok: false, reason: "storage-unavailable" });
    expect(await none.advance()).toMatchObject({ ok: false, reason: "storage-unavailable" });
  });
  it("writes nothing when the shared lock cannot be acquired", async () => {
    const storage = new MemStorage(); storage.values.set(STORAGE_KEY, LEGACY);
    const controller = createCutoverController({
      storage, stages: fakeStages({ calls: [], hooks: {} }),
      runExclusive: async () => ({ ok: false, reason: "lock-timeout", message: "timeout" }),
      confirmLegacyWritersQuiesced: async () => true
    });
    const plan = controller.preflight(); if (!plan.ok) throw new Error("x");
    expect(await controller.begin(plan.plan)).toMatchObject({ ok: false, reason: "lock-timeout" });
    expect(await controller.advance()).toMatchObject({ ok: false, reason: "lock-timeout" });
    expect(storage.sets).toEqual([]);
  });
});

describe("lifecycle, ordering and forward-only recovery", () => {
  it("advances one validated phase at a time through all four phases", async () => {
    const ctx = await begun();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await ctx.controller.advance();
      expect(result).toMatchObject({ ok: true, changed: true });
      const state = readCutoverState(ctx.storage); seen.push(state.mode === "legacy" || state.mode === "indeterminate" ? state.mode : state.marker.phase);
    }
    expect(seen).toEqual(["profiles-verified", "stores-verified", "committed"]);
    expect(ctx.log.calls).toEqual(["migrateProfiles", "verifyProfiles", "verifyStores", "verifyStores"]);
    expect(readCutoverState(ctx.storage)).toMatchObject({ mode: "durable" });
  });
  it("resume reaches committed, is deterministic, and is idempotent afterwards", async () => {
    const ctx = await begun();
    expect(await ctx.controller.resume()).toMatchObject({ ok: true, changed: true, state: { mode: "durable" } });
    ctx.storage.sets.length = 0; ctx.log.calls.length = 0;
    expect(await ctx.controller.resume()).toMatchObject({ ok: true, changed: false, state: { mode: "durable" } });
    expect(ctx.storage.sets).toEqual([]); expect(ctx.log.calls).toEqual([]);
    expect(await ctx.controller.advance()).toMatchObject({ ok: true, changed: false });
  });
  it("never moves backward: the marker phase index only increases and startedAt/fingerprint are preserved", async () => {
    const ctx = await begun();
    const phases: number[] = [];
    while (readCutoverState(ctx.storage).mode !== "durable") {
      await ctx.controller.advance();
      const state = readCutoverState(ctx.storage); if (state.mode === "legacy" || state.mode === "indeterminate") throw new Error("x");
      phases.push(CUTOVER_PHASES.indexOf(state.marker.phase));
      expect(state.marker).toMatchObject({ startedAt: NOW, sourceFingerprint: fingerprintSource(LEGACY) });
    }
    expect(phases).toEqual([1, 2, 3]);
  });
  it("restarts deterministically: a fresh controller resumes from the stored phase without redoing earlier stages", async () => {
    const ctx = await begun();
    await toPhase(ctx, "profiles-verified");
    const restarted = ctx.make();
    expect(await restarted.resume()).toMatchObject({ ok: true, state: { mode: "durable" } });
    expect(ctx.log.calls).toEqual(["verifyStores", "verifyStores"]);
  });
  it("an interrupted stage leaves the intent marker in place and a retry completes", async () => {
    const ctx = await begun();
    let crash = true;
    ctx.log.hooks.migrateProfiles = () => { if (crash) { crash = false; throw new Error("tab closed"); } };
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "stage-failed", stageReason: "threw", state: { mode: "recovery", phase: "intent" } });
    expect(ctx.storage.sets).toEqual([]);
    expect(await ctx.make().resume()).toMatchObject({ ok: true, state: { mode: "durable" } });
  });
  it("a failing stage reports its own reason and does not advance", async () => {
    const ctx = await begun();
    ctx.log.hooks.migrateProfiles = () => ({ ok: false, reason: "snapshot-full", message: "No free slot" });
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "stage-failed", stageReason: "snapshot-full", state: { mode: "recovery", phase: "intent" } });
  });
  it.each([["intent", "profiles-verified"], ["profiles-verified", "stores-verified"], ["stores-verified", "committed"]] as const)(
    "a marker-write failure while advancing %s -> %s keeps the old phase, blocks legacy writes, and a retry succeeds", async (from, to) => {
      const ctx = await begun(); await toPhase(ctx, from);
      ctx.storage.failSet = (key) => (key === CUTOVER_MARKER_KEY ? domError("QuotaExceededError", 22) : null);
      expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "marker-write-failed", state: { mode: "recovery", phase: from } });
      expect(saveProjects([{ id: "x", name: "x", tasks: [] }], ctx.storage)).toMatchObject({ ok: false, reason: "cutover-active" });
      ctx.storage.failSet = null;
      expect(await ctx.controller.advance()).toMatchObject({ ok: true, changed: true });
      expect(readCutoverState(ctx.storage)).toMatchObject({ marker: { phase: to } });
    });
  it("a read-back failure after an advance write is reported and never rolled back", async () => {
    const ctx = await begun();
    ctx.storage.corruptReadAfterSet = (key) => key === CUTOVER_MARKER_KEY;
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "marker-verify-failed" });
    expect(ctx.storage.removed).toEqual([]);
    expect(readCutoverState(ctx.storage)).toMatchObject({ mode: "recovery", phase: "profiles-verified" });
  });
  it("refuses to advance without a marker, with a malformed marker, or with an unreadable marker", async () => {
    const none = setup(); expect(await none.controller.advance()).toMatchObject({ ok: false, reason: "no-marker" });
    const bad = setup(); bad.storage.values.set(CUTOVER_MARKER_KEY, "{broken");
    expect(await bad.controller.advance()).toMatchObject({ ok: false, reason: "marker-invalid", state: { mode: "indeterminate" } });
    expect(bad.log.calls).toEqual([]); expect(bad.storage.sets).toEqual([]);
    const unreadable = await begun(); unreadable.storage.failGet = (key) => (key === CUTOVER_MARKER_KEY ? domError("SecurityError") : null);
    expect(await unreadable.controller.advance()).toMatchObject({ ok: false, reason: "marker-invalid" });
  });
  it("detects a marker rewritten while a stage was running (CAS on the marker bytes)", async () => {
    const ctx = await begun();
    ctx.log.hooks.migrateProfiles = () => { ctx.storage.values.set(CUTOVER_MARKER_KEY, serializeMarker(marker({ phase: "stores-verified" }))); };
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "marker-changed" });
    expect(ctx.storage.sets).toEqual([]);
  });
  it("never removes anything during the whole lifecycle", async () => {
    const ctx = setup(); const plan = ctx.controller.preflight(); if (!plan.ok) throw new Error("x");
    await ctx.controller.begin(plan.plan); await ctx.controller.resume();
    expect(ctx.storage.removed).toEqual([]);
    expect(ctx.storage.values.get(STORAGE_KEY)).toBe(LEGACY);
  });
  it("two tabs resuming concurrently under the shared lock commit exactly once", async () => {
    const ctx = await begun();
    const [a, b] = await Promise.all([ctx.make().resume(), ctx.make().resume()]);
    expect(a.ok && b.ok).toBe(true);
    expect(ctx.log.calls.filter((name) => name === "migrateProfiles")).toHaveLength(1);
    expect(readCutoverState(ctx.storage)).toMatchObject({ mode: "durable" });
  });
});

describe("R1: source revalidation before every stage advancement (stale tabs and older bundles)", () => {
  const stale = (storage: MemStorage) => storage.values.set(STORAGE_KEY, `${LEGACY.slice(0, -1)},{"id":"late","name":"Late","tasks":[]}]`);
  it.each(["intent", "profiles-verified", "stores-verified"] as const)("a legacy write after phase %s stops the advance, preserves the new bytes, and reports indeterminate", async (phase) => {
    const ctx = await begun(); await toPhase(ctx, phase);
    stale(ctx.storage);
    const changed = ctx.storage.values.get(STORAGE_KEY)!;
    const result = await ctx.controller.advance();
    expect(result).toMatchObject({ ok: false, reason: "source-changed", divergentPreserved: true, state: { mode: "indeterminate", reason: "source-changed" } });
    expect(ctx.storage.values.get(copyKeyFor(changed))).toBe(changed);
    expect(ctx.storage.values.get(copyKeyFor(LEGACY))).toBe(LEGACY);
    expect(readCutoverState(ctx.storage)).toMatchObject({ marker: { phase } });
    expect(ctx.log.calls).toEqual([]);
    expect(ctx.controller.inspect()).toMatchObject({ mode: "indeterminate", reason: "source-changed" });
    expect(await ctx.make().resume()).toMatchObject({ ok: false, reason: "source-changed" });
  });
  it("a legacy write after commit is still detected", async () => {
    const ctx = await begun(); await ctx.controller.resume(); stale(ctx.storage);
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "source-changed" });
    expect(ctx.controller.inspect()).toMatchObject({ mode: "indeterminate", reason: "source-changed" });
  });
  it("a legacy write during stage work is caught by the second revalidation and nothing advances", async () => {
    const ctx = await begun();
    ctx.log.hooks.verifyProfiles = () => { stale(ctx.storage); };
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "source-changed" });
    expect(readCutoverState(ctx.storage)).toMatchObject({ marker: { phase: "intent" } });
  });
  it("detects a missing preserved copy and refuses to advance", async () => {
    const ctx = await begun(); ctx.storage.values.delete(copyKeyFor(LEGACY));
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "source-copy-missing" });
    expect(ctx.controller.inspect()).toMatchObject({ mode: "indeterminate", reason: "source-copy-missing" });
  });
  it("compares full bytes, not only the fingerprint (same fingerprint, different bytes)", async () => {
    const ctx = await begun();
    ctx.storage.values.set(copyKeyFor(LEGACY), `${LEGACY} `);
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "source-changed" });
  });
  it("reports an unreadable source and keeps the marker", async () => {
    const ctx = await begun();
    ctx.storage.failGet = (key) => (key === STORAGE_KEY ? domError("SecurityError") : null);
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "source-unreadable" });
  });
  it("a changed absent source is detected", async () => {
    const ctx = await begun(null);
    ctx.storage.values.set(STORAGE_KEY, "[]");
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "source-changed" });
  });
});

describe("abort eligibility (R4) and export (R5)", () => {
  it("is read-only and eligible only at intent with an unchanged source and proof of no durable state", async () => {
    const ctx = await begun();
    const report = await ctx.controller.verifyAbortEligibility();
    expect(report.eligible).toBe(true);
    expect(ctx.storage.sets).toEqual([]); expect(ctx.storage.removed).toEqual([]);
    expect(ctx.storage.values.has(CUTOVER_MARKER_KEY)).toBe(true);
  });
  it("is not eligible when the source changed, a later phase was reached, durable state exists, or it cannot be proven", async () => {
    const changed = await begun(); changed.storage.values.set(STORAGE_KEY, "[]");
    expect((await changed.controller.verifyAbortEligibility()).eligible).toBe(false);
    const later = await begun(); await toPhase(later, "profiles-verified");
    expect((await later.controller.verifyAbortEligibility()).eligible).toBe(false);
    const withDurable = await begun();
    const c = createCutoverController({ storage: withDurable.storage, stages: fakeStages(withDurable.log, true), runExclusive: withDurable.lock });
    expect((await c.verifyAbortEligibility()).eligible).toBe(false);
    const unproven = await begun();
    const c2 = createCutoverController({ storage: unproven.storage, stages: { ...fakeStages(unproven.log), hasDurableState: undefined }, runExclusive: unproven.lock });
    expect((await c2.verifyAbortEligibility()).eligible).toBe(false);
  });
  it("exports the preserved raw bytes exactly, handles absent sources, and reports a missing copy", async () => {
    const ctx = await begun();
    expect(ctx.controller.exportPreservedSource()).toMatchObject({ ok: true, raw: LEGACY, fingerprint: fingerprintSource(LEGACY) });
    const absent = await begun(null);
    expect(absent.controller.exportPreservedSource()).toMatchObject({ ok: true, raw: null, fingerprint: "absent" });
    ctx.storage.values.delete(copyKeyFor(LEGACY));
    expect(ctx.controller.exportPreservedSource()).toMatchObject({ ok: false, reason: "source-copy-missing" });
    expect(setup().controller.exportPreservedSource()).toMatchObject({ ok: false, reason: "no-marker" });
  });
});

describe("all legacy writer paths are blocked once any marker exists", () => {
  beforeEach(() => installFakeLocks());
  afterEach(() => uninstallLocks());
  const markers: [string, string][] = [
    ...CUTOVER_PHASES.map((phase): [string, string] => [phase, serializeMarker(marker({ phase }))]),
    ["malformed", "{broken"], ["empty bytes", ""]
  ];
  it.each(markers)("with marker state %s: save, locked save, restore and delete refuse and change nothing; reads still work", async (_name, raw) => {
    const storage = new MemStorage();
    storage.values.set(STORAGE_KEY, LEGACY);
    storage.values.set(BACKUP_KEY, JSON.stringify([{ id: "old", name: "Old", tasks: [] }]));
    storage.values.set(CUTOVER_MARKER_KEY, raw);
    const before = new Map(storage.values);
    const next = [{ id: "n", name: "N", tasks: [] }];
    expect(saveProjects(next, storage)).toMatchObject({ ok: false, reason: "cutover-active" });
    expect(await saveProjectsLocked(next, storage)).toMatchObject({ ok: false, reason: "cutover-active" });
    expect(await restoreBackup(BACKUP_KEY, storage)).toMatchObject({ ok: false, reason: "cutover-active" });
    expect(await deleteBackup(BACKUP_KEY, storage)).toMatchObject({ ok: false, reason: "cutover-active" });
    expect(storage.values).toEqual(before);
    expect(storage.sets.filter((key) => key !== CUTOVER_MARKER_KEY)).toEqual([]);
    expect(storage.removed).toEqual([]);
    expect(readProjects(storage).projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(listBackups(storage)).toHaveLength(1);
  });
  it("an unreadable marker blocks delete and restore as well", async () => {
    const storage = new MemStorage();
    storage.values.set(BACKUP_KEY, "[]");
    storage.failGet = (key) => (key === CUTOVER_MARKER_KEY ? new Error("marker read failed") : null);
    expect(await deleteBackup(BACKUP_KEY, storage)).toMatchObject({ ok: false, reason: "cutover-indeterminate" });
    expect(await restoreBackup(BACKUP_KEY, storage)).toMatchObject({ ok: false, reason: "cutover-indeterminate" });
    expect(storage.values.has(BACKUP_KEY)).toBe(true);
  });
  it("without a marker the legacy writers still work (legacy mode is unchanged)", async () => {
    const storage = new MemStorage();
    expect(saveProjects([{ id: "n", name: "N", tasks: [] }], storage)).toMatchObject({ ok: true });
    storage.values.set(BACKUP_KEY, "[]");
    expect(await deleteBackup(BACKUP_KEY, storage)).toMatchObject({ ok: true });
  });
});

describe("production stages over the real PR-B / PR-C adapters (in-memory storage, shared lock)", () => {
  beforeEach(() => installFakeLocks());
  afterEach(() => uninstallLocks());
  function real(raw: string | null = LEGACY) {
    const storage = new MemStorage();
    if (raw !== null) storage.values.set(STORAGE_KEY, raw);
    // Default lock runner (navigator.locks) on purpose: stages must not request the lock again.
    const controller = createCutoverController({ storage, stages: createCutoverStages({ storage, now: () => NOW }), now: () => NOW, confirmLegacyWritersQuiesced: async () => true });
    return { storage, controller };
  }
  const full = async (ctx: ReturnType<typeof real>) => {
    const plan = ctx.controller.preflight(); if (!plan.ok) throw new Error("preflight");
    const begun = await ctx.controller.begin(plan.plan); if (!begun.ok) throw new Error(begun.message);
    return ctx.controller.resume();
  };
  it("completes the lifecycle without deadlocking, creating profiles per project and no governed tasks", async () => {
    const ctx = real();
    expect(await full(ctx)).toMatchObject({ ok: true, state: { mode: "durable" } });
    const profiles = JSON.parse(ctx.storage.values.get(durableStoreKey("project-profiles"))!) as { records: Record<string, { projectId: string }> };
    expect(Object.keys(profiles.records).sort()).toEqual(["p1", "p2"]);
    for (const [id, profile] of Object.entries(profiles.records)) expect(profile.projectId).toBe(id);
    expect(ctx.storage.values.has(durableStoreKey("task-ledger"))).toBe(false);
    expect(ctx.storage.values.get(STORAGE_KEY)).toBe(LEGACY);
    expect(ctx.storage.values.get(copyKeyFor(LEGACY))).toBe(LEGACY);
    expect(JSON.stringify(profiles)).not.toContain("Legacy task");
  });
  it("is idempotent: a second run on a committed cutover writes nothing", async () => {
    const ctx = real(); await full(ctx);
    ctx.storage.sets.length = 0;
    expect(await ctx.controller.resume()).toMatchObject({ ok: true, changed: false });
    expect(ctx.storage.sets).toEqual([]);
  });
  it("restart after every phase completes the same final state", async () => {
    for (const stopAfter of [0, 1, 2]) {
      const ctx = real();
      const plan = ctx.controller.preflight(); if (!plan.ok) throw new Error("x");
      await ctx.controller.begin(plan.plan);
      for (let i = 0; i < stopAfter; i++) await ctx.controller.advance();
      const restarted = createCutoverController({ storage: ctx.storage, stages: createCutoverStages({ storage: ctx.storage, now: () => NOW }), now: () => NOW, confirmLegacyWritersQuiesced: async () => true });
      expect(await restarted.resume()).toMatchObject({ ok: true, state: { mode: "durable" } });
      expect(ctx.storage.values.get(STORAGE_KEY)).toBe(LEGACY);
    }
  });
  it("a missing legacy workspace still yields a valid durable profile envelope after the marker", async () => {
    const ctx = real(null);
    expect(await full(ctx)).toMatchObject({ ok: true, state: { mode: "durable", marker: { sourceFingerprint: "absent" } } });
    expect(JSON.parse(ctx.storage.values.get(durableStoreKey("project-profiles"))!)).toMatchObject({ schemaVersion: 1, records: {} });
    expect(ctx.storage.values.has(STORAGE_KEY)).toBe(false);
  });
  it("never promotes legacy tasks: legacy bytes keep their raw task records and no ledger exists", async () => {
    const ctx = real(); await full(ctx);
    expect(ctx.storage.values.get(STORAGE_KEY)).toContain('"done":true');
    expect([...ctx.storage.values.keys()].some((key) => key.includes("task-ledger"))).toBe(false);
  });
  it("snapshot exhaustion stops at intent without overwriting any slot or touching legacy data", async () => {
    const ctx = real();
    for (let slot = 1; slot <= 5; slot++) ctx.storage.values.set(durableBackupKey("project-profiles", slot), `occupied-${slot}`);
    const before = new Map(ctx.storage.values);
    const result = await full(ctx);
    expect(result).toMatchObject({ ok: false, reason: "stage-failed", stageReason: "snapshot-full", state: { mode: "recovery", phase: "intent" } });
    for (let slot = 1; slot <= 5; slot++) expect(ctx.storage.values.get(durableBackupKey("project-profiles", slot))).toBe(before.get(durableBackupKey("project-profiles", slot)));
    expect(ctx.storage.values.get(STORAGE_KEY)).toBe(LEGACY);
    expect(saveProjects([{ id: "x", name: "x", tasks: [] }], ctx.storage)).toMatchObject({ ok: false, reason: "cutover-active" });
  });
  it("quota exhaustion while writing durable profiles stops at intent and preserves legacy bytes", async () => {
    const ctx = real();
    const plan = ctx.controller.preflight(); if (!plan.ok) throw new Error("x");
    await ctx.controller.begin(plan.plan);
    ctx.storage.failSet = (key) => (key.startsWith("devmate-durable-store-v1") || key.startsWith("devmate-durable-journal-v1") ? domError("QuotaExceededError", 22) : null);
    const result = await ctx.controller.advance();
    expect(result).toMatchObject({ ok: false, reason: "stage-failed", state: { mode: "recovery", phase: "intent" } });
    expect(ctx.storage.values.get(STORAGE_KEY)).toBe(LEGACY);
    ctx.storage.failSet = null;
    expect(await ctx.controller.resume()).toMatchObject({ ok: true, state: { mode: "durable" } });
  });
  it("refuses a malformed legacy workspace without partial migration", async () => {
    const ctx = real('{"not":"an array"}');
    const result = await full(ctx);
    expect(result).toMatchObject({ ok: false, reason: "stage-failed", state: { mode: "recovery", phase: "intent" } });
    expect(ctx.storage.values.has(durableStoreKey("project-profiles"))).toBe(false);
    expect(ctx.storage.values.get(STORAGE_KEY)).toBe('{"not":"an array"}');
  });
  it("a corrupted durable profile store after migration blocks verification", async () => {
    const ctx = real();
    const plan = ctx.controller.preflight(); if (!plan.ok) throw new Error("x");
    await ctx.controller.begin(plan.plan); await ctx.controller.advance();
    ctx.storage.values.set(durableStoreKey("project-profiles"), "{corrupt");
    expect(await ctx.controller.advance()).toMatchObject({ ok: false, reason: "stage-failed", state: { mode: "recovery", phase: "profiles-verified" } });
  });
  it("project isolation: a profile record for one project never appears under another id", async () => {
    const ctx = real(); await full(ctx);
    const records = (JSON.parse(ctx.storage.values.get(durableStoreKey("project-profiles"))!) as { records: Record<string, { projectId: string; name?: string }> }).records;
    expect(records.p1.projectId).toBe("p1"); expect(records.p2.projectId).toBe("p2");
    expect(JSON.stringify(records.p2)).not.toContain("Project one");
  });
});
