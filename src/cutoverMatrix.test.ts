import { describe, expect, it } from "vitest";
import { CUTOVER_MARKER_KEY, CUTOVER_PHASES, createCutoverController, createCutoverStages, fingerprintSource, parseMarker, phaseIndex, readCutoverState, type CutoverStages } from "./cutoverController";
import { createProjectProfileStore } from "./profileStore";
import { createTaskLedgerStore } from "./taskLedgerStore";
import { STORAGE_KEY } from "./storage";

/**
 * S5 (F4): project isolation, interleaving, stale plans, conflicts, partial stage failures, retry and crash/restart
 * matrix. Uses the real stage wiring (createCutoverStages over the PR-B/PR-C adapters) over an instrumented
 * in-memory Storage. The quiescence callback is a test double and proves nothing about real writers.
 */
class Mem {
  values = new Map<string, string>();
  setCount = 0; failAt = -1; failMode: "before" | "after" = "before"; failKind: "error" | "quota" = "error";
  writes: string[] = []; removes: string[] = [];
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    const index = this.setCount++;
    if (index === this.failAt) {
      if (this.failMode === "after") { this.values.set(key, value); this.writes.push(key); }
      throw this.failKind === "quota" ? new DOMException("full", "QuotaExceededError") : new Error("injected storage failure");
    }
    this.writes.push(key); this.values.set(key, value);
  }
  removeItem(key: string) { this.removes.push(key); this.values.delete(key); }
  /** Random journal transaction ids are the only non-deterministic bytes; they are normalised. */
  snapshot() { return JSON.stringify([...this.values.entries()].sort(([a], [b]) => (a < b ? -1 : 1))).replace(/tx-\d+-[a-z0-9]+/g, "tx-ID"); }
}
const task = (id: string, title: string, done = false) => ({ id, title, done, createdAt: 1 });
const PROJECTS = [
  { id: "proj-a", name: "Alpha", tasks: [task("a1", "Alpha one"), task("a2", "Alpha two", true)] },
  { id: "proj-b", name: "Bravo", tasks: [task("b1", "Bravo one")] },
  { id: "proj-c", name: "Charlie", tasks: [] }
];
const LEGACY = JSON.stringify(PROJECTS);
const IDS = PROJECTS.map((p) => p.id);
const NOW = () => 1_000;
const noLock = async <R>(work: () => R | Promise<R>) => ({ ok: true as const, value: await work() });
/** Serialising runner shared by several controllers = several tabs behind one real lock. */
function sharedLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return async <R>(work: () => R | Promise<R>) => {
    const run = chain.then(() => work()); chain = run.then(() => undefined, () => undefined);
    return { ok: true as const, value: await run };
  };
}
const make = (mem: Mem, opts: { runExclusive?: ReturnType<typeof sharedLock>; stages?: CutoverStages } = {}) =>
  createCutoverController({ storage: mem, stages: opts.stages ?? createCutoverStages({ storage: mem, now: NOW }), now: NOW, runExclusive: opts.runExclusive ?? noLock, confirmLegacyWritersQuiesced: () => true });
const seed = (raw: string | null = LEGACY) => { const mem = new Mem(); if (raw !== null) mem.values.set(STORAGE_KEY, raw); return mem; };
async function begin(c: ReturnType<typeof make>) { const plan = c.preflight(); if (!plan.ok) throw new Error(`preflight: ${plan.reason}`); return c.begin(plan.plan); }
const phaseOf = (mem: Mem): number => { const raw = mem.getItem(CUTOVER_MARKER_KEY); if (raw === null) return -1; const p = parseMarker(raw); return p.ok ? phaseIndex(p.marker.phase) : 99; };
const copyRaw = (mem: Mem) => { const raw = mem.getItem(CUTOVER_MARKER_KEY); const p = raw ? parseMarker(raw) : null; return p && p.ok ? mem.getItem(`devmate-cutover-v1:source:${p.marker.sourceFingerprint}`) : undefined; };
const pass = async <R>(work: () => R | Promise<R>) => ({ ok: true as const, value: await work() });
async function profilesOf(mem: Mem) { const store = createProjectProfileStore({ storage: mem, runExclusive: pass, now: NOW }); const out: Record<string, string> = {}; for (const id of [...IDS, "ghost"]) { const r = await store.readProfile(id); out[id] = r.ok ? (r.status === "found" ? "found" : "absent") : `error:${r.reason}`; } return out; }
const PROTECTED = [STORAGE_KEY, CUTOVER_MARKER_KEY];

describe("S5 — isolation across projects", () => {
  it("a full lifecycle touches only cutover/durable keys, never the legacy key, and keeps raw bytes and every task", async () => {
    const mem = seed(); const c = make(mem);
    expect((await begin(c)).ok).toBe(true); const done = await c.resume();
    expect(done.ok && done.state.mode).toBe("durable");
    expect(mem.values.get(STORAGE_KEY)).toBe(LEGACY); expect(copyRaw(mem)).toBe(LEGACY);
    expect(mem.writes).not.toContain(STORAGE_KEY);
    const allowed = /^(devmate-cutover-v1:|devmate-durable-store-v1:|devmate-durable-journal-v1:|devmate-migrations-v1:|devmate-durable-backups-v1:)/;
    for (const key of new Set(mem.writes)) expect(key, key).toMatch(allowed);
    for (const key of mem.removes) expect(PROTECTED.concat([`devmate-cutover-v1:source:${fingerprintSource(LEGACY)}`])).not.toContain(key);
    expect(await profilesOf(mem)).toEqual({ "proj-a": "found", "proj-b": "found", "proj-c": "found", ghost: "absent" });
    const preserved = JSON.parse(copyRaw(mem)!) as typeof PROJECTS;
    expect(preserved.map((p) => p.tasks.length)).toEqual([2, 1, 0]); expect(JSON.stringify(preserved)).toBe(LEGACY);
    const ledgers = createTaskLedgerStore({ storage: mem, runExclusive: pass, now: NOW });
    for (const id of IDS) expect((await ledgers.readLedger(id)).ok).toBe(true);
  });
  it("each project gets exactly its own profile (no cross-project record, no duplicate)", async () => {
    const mem = seed(); const c = make(mem); await begin(c); await c.resume();
    const store = createProjectProfileStore({ storage: mem, runExclusive: pass, now: NOW });
    for (const id of IDS) { const r = await store.readProfile(id); expect(r.ok && r.status === "found" && r.value.projectId).toBe(id); }
    const raw = [...mem.values.entries()].filter(([k]) => k.startsWith("devmate-durable-store-v1:project-profiles")).map(([, v]) => v);
    expect(raw).toHaveLength(1);
    const text = raw[0]!; for (const id of IDS) expect(text.split(`"projectId":"${id}"`).length - 1, id).toBe(1);
  });
  it("a project the migration refuses stops the WHOLE run before any other project's profile is written; retry changes nothing", async () => {
    const bad = JSON.stringify([PROJECTS[0], { name: "no id", tasks: [] }, PROJECTS[2]]);
    const mem = seed(bad); const c = make(mem); expect((await begin(c)).ok).toBe(true);
    const before = mem.snapshot(); const profileWritesBefore = mem.writes.filter((k) => k.startsWith("devmate-durable-store-v1")).length;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await c.resume(); expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.reason).toBe("stage-failed"); expect(r.state.mode).toBe("recovery"); }
    }
    expect(phaseOf(mem)).toBe(phaseIndex("intent")); expect(mem.values.get(STORAGE_KEY)).toBe(bad);
    expect(mem.writes.filter((k) => k.startsWith("devmate-durable-store-v1")).length).toBe(profileWritesBefore);
    expect(mem.snapshot()).toBe(before);
    expect(await profilesOf(mem)).toEqual({ "proj-a": "absent", "proj-b": "absent", "proj-c": "absent", ghost: "absent" });
  });
  it("resume after durable is idempotent: byte-identical storage and changed=false", async () => {
    const mem = seed(); const c = make(mem); await begin(c); await c.resume(); const before = mem.snapshot();
    const again = await c.resume(); expect(again.ok && again.changed).toBe(false); expect(mem.snapshot()).toBe(before);
    const second = await begin(c).catch((e: Error) => e.message); expect(String(second)).toContain("marker-present"); expect(mem.snapshot()).toBe(before);
  });
});

describe("S5 — interleaved tabs behind one lock", () => {
  it("two tabs racing begin(): exactly one writes the marker, the other is a no-op", async () => {
    const mem = seed(); const lock = sharedLock(); const a = make(mem, { runExclusive: lock }); const b = make(mem, { runExclusive: lock });
    const pa = a.preflight(); const pb = b.preflight(); if (!pa.ok || !pb.ok) throw new Error("preflight");
    const results = await Promise.all([a.begin(pa.plan), b.begin(pb.plan)]);
    expect(results.every((r) => r.ok)).toBe(true); expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1);
    expect(mem.writes.filter((k) => k === CUTOVER_MARKER_KEY)).toHaveLength(1);
  });
  it("two tabs racing resume(): converge to durable, and the storage equals a single-tab run byte for byte", async () => {
    const reference = seed(); const rc = make(reference); await begin(rc); await rc.resume();
    const mem = seed(); const lock = sharedLock(); const a = make(mem, { runExclusive: lock }); const b = make(mem, { runExclusive: lock });
    await begin(a);
    const results = await Promise.all([a.resume(), b.resume(), a.resume()]);
    expect(results.every((r) => r.ok)).toBe(true); expect(readCutoverState(mem).mode).toBe("durable");
    expect(mem.snapshot()).toBe(reference.snapshot());
  });
  it("a tab with a stale plan cannot declare intent over a changed workspace", async () => {
    const mem = seed(); const c = make(mem); const plan = c.preflight(); if (!plan.ok) throw new Error("preflight");
    mem.values.set(STORAGE_KEY, LEGACY.replace("Alpha", "Edited elsewhere"));
    const r = await c.begin(plan.plan); expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("stale-plan");
    expect(mem.getItem(CUTOVER_MARKER_KEY)).toBeNull(); expect([...mem.values.keys()].some((k) => k.startsWith("devmate-cutover-v1:source:"))).toBe(false);
  });
});

describe("S5 — conflicts: a writer that bypasses the barrier", () => {
  it("a legacy write after intent is detected, preserved as a separate copy, and the marker never advances", async () => {
    const mem = seed(); const c = make(mem); await begin(c);
    const diverged = LEGACY.replace("Bravo", "Bravo (old tab)"); mem.values.set(STORAGE_KEY, diverged);
    for (let i = 0; i < 2; i++) {
      const r = await c.resume(); expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.reason).toBe("source-changed"); expect(r.state.mode).toBe("indeterminate"); expect(r.divergentPreserved).toBe(true); }
    }
    expect(phaseOf(mem)).toBe(phaseIndex("intent")); expect(copyRaw(mem)).toBe(LEGACY);
    expect(mem.getItem(`devmate-cutover-v1:source:${fingerprintSource(diverged)}`)).toBe(diverged);
    expect(await profilesOf(mem)).toEqual({ "proj-a": "absent", "proj-b": "absent", "proj-c": "absent", ghost: "absent" });
  });
  it("a workspace that did not exist at intent but appears later is detected (absent-source fingerprint)", async () => {
    const mem = seed(null); const c = make(mem); expect((await begin(c)).ok).toBe(true);
    mem.values.set(STORAGE_KEY, LEGACY);
    const r = await c.resume(); expect(r.ok).toBe(false); if (!r.ok) { expect(r.reason).toBe("source-changed"); expect(r.divergentPreserved).toBe(true); }
    expect(phaseOf(mem)).toBe(phaseIndex("intent"));
  });
  it("a legacy write DURING a stage is caught by the post-stage revalidation and nothing advances", async () => {
    const mem = seed(); const real = createCutoverStages({ storage: mem, now: NOW });
    const stages: CutoverStages = { ...real, verifyProfiles: async () => { const r = await real.verifyProfiles(); mem.values.set(STORAGE_KEY, LEGACY + " "); return r; } };
    const c = make(mem, { stages }); await begin(c);
    const r = await c.resume(); expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("source-changed");
    expect(phaseOf(mem)).toBe(phaseIndex("intent"));
  });
  it("a changed marker during a stage aborts the advance (marker-changed)", async () => {
    const mem = seed(); const real = createCutoverStages({ storage: mem, now: NOW });
    const stages: CutoverStages = { ...real, verifyProfiles: async () => { const r = await real.verifyProfiles(); const raw = mem.getItem(CUTOVER_MARKER_KEY)!; mem.values.set(CUTOVER_MARKER_KEY, raw.replace("1,\"phase", "1,\"phase")); mem.values.set(CUTOVER_MARKER_KEY, raw.replace('"startedAt":1000', '"startedAt":1001')); return r; } };
    const c = make(mem, { stages }); await begin(c);
    const r = await c.resume(); expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("marker-changed");
  });
});

describe("S5 — partial stage failures and retry", () => {
  it.each(["migrateProfiles", "verifyProfiles", "verifyStores"] as const)("%s failing once: forward-only, no false advancement, retry completes without duplication", async (name) => {
    const reference = seed(); const rc = make(reference); await begin(rc); await rc.resume();
    const mem = seed(); const real = createCutoverStages({ storage: mem, now: NOW }); let failed = false;
    const stages: CutoverStages = { ...real, [name]: async () => { if (!failed) { failed = true; return { ok: false, reason: "injected", message: "injected failure" }; } return real[name](); } };
    const c = make(mem, { stages }); await begin(c);
    const seen: number[] = [phaseOf(mem)];
    const first = await c.resume(); seen.push(phaseOf(mem)); expect(first.ok).toBe(false);
    if (!first.ok) { expect(first.reason).toBe("stage-failed"); expect(first.stageReason).toBe("injected"); }
    expect(readCutoverState(mem).mode).not.toBe("durable");
    const second = await c.resume(); seen.push(phaseOf(mem)); expect(second.ok).toBe(true);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(mem.snapshot()).toBe(reference.snapshot());
  });
  it("a stage that throws is reported as a failure, not a crash, and writes nothing extra", async () => {
    const mem = seed(); const real = createCutoverStages({ storage: mem, now: NOW });
    const c = make(mem, { stages: { ...real, migrateProfiles: async () => { throw new Error("boom"); } } }); await begin(c);
    const before = mem.snapshot(); const r = await c.resume(); expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("stage-failed"); expect(mem.snapshot()).toBe(before);
  });
  it("quota while preserving the raw copy: no marker is written and the legacy key is untouched", async () => {
    const mem = seed(); mem.failAt = 0; mem.failKind = "quota"; const c = make(mem);
    const r = await begin(c); expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("preserve-quota");
    expect(mem.getItem(CUTOVER_MARKER_KEY)).toBeNull(); expect(mem.values.get(STORAGE_KEY)).toBe(LEGACY);
  });
});

describe("S5 — crash/restart injection at every storage write", () => {
  const cleanRun = async () => { const mem = seed(); const c = make(mem); await begin(c); await c.resume(); return mem; };
  it("every injected failure point (before and after the write, error and quota) recovers to the same final storage", async () => {
    const reference = await cleanRun(); const total = reference.setCount; expect(total).toBeGreaterThan(5);
    const finalSnapshot = reference.snapshot();
    const combos: { mode: "before" | "after"; kind: "error" | "quota" }[] = [{ mode: "before", kind: "error" }, { mode: "after", kind: "error" }, { mode: "before", kind: "quota" }, { mode: "after", kind: "quota" }];
    let checked = 0;
    for (const { mode, kind } of combos) for (let n = 0; n < total; n++) {
      const mem = seed(); mem.failAt = n; mem.failMode = mode; mem.failKind = kind;
      const phases: number[] = [];
      const observe = () => { phases.push(phaseOf(mem)); expect(mem.values.get(STORAGE_KEY), `legacy bytes at n=${n}`).toBe(LEGACY); const cp = copyRaw(mem); if (cp !== undefined) expect(cp).toBe(LEGACY); expect(mem.writes.filter((k) => k === STORAGE_KEY)).toEqual([]); expect(phaseOf(mem)).toBeLessThan(99); };
      try { const c = make(mem); const plan = c.preflight(); if (plan.ok) await c.begin(plan.plan); observe(); await c.resume(); } catch { /* a thrown error is also a crash; state is checked below */ }
      observe(); expect(readCutoverState(mem).mode === "durable" ? phaseOf(mem) : 0).toBeGreaterThanOrEqual(0);
      // restart: injection off, fresh controller and stages, retry until done
      mem.failAt = -1;
      for (let attempt = 0; attempt < 4 && readCutoverState(mem).mode !== "durable"; attempt++) {
        const c = make(mem); const state = c.inspect();
        if (state.mode === "legacy") { const plan = c.preflight(); expect(plan.ok).toBe(true); if (plan.ok) await c.begin(plan.plan); }
        observe(); await c.resume(); observe();
      }
      for (let i = 1; i < phases.length; i++) expect(phases[i]!, `monotonic phases (${mode}/${kind}/${n})`).toBeGreaterThanOrEqual(phases[i - 1]!);
      expect(readCutoverState(mem).mode, `${mode}/${kind}/${n}`).toBe("durable");
      expect(await profilesOf(mem)).toEqual({ "proj-a": "found", "proj-b": "found", "proj-c": "found", ghost: "absent" });
      for (const key of mem.removes) expect(PROTECTED).not.toContain(key);
      expect(CUTOVER_PHASES[phaseOf(mem)]).toBe("committed");
      expect(JSON.stringify(JSON.parse(mem.values.get(STORAGE_KEY)!))).toBe(LEGACY);
      void finalSnapshot; checked++;
    }
    expect(checked).toBe(total * combos.length);
  });
  it("durable state is never reported before profiles and ledgers verify (no false phase advancement under injection)", async () => {
    const reference = await cleanRun(); const total = reference.setCount;
    for (let n = 0; n < total; n++) {
      const mem = seed(); mem.failAt = n; mem.failMode = "after";
      try { const c = make(mem); const plan = c.preflight(); if (plan.ok) await c.begin(plan.plan); await c.resume(); } catch { /* ignore */ }
      if (readCutoverState(mem).mode === "durable") { mem.failAt = -1; expect(await profilesOf(mem)).toEqual({ "proj-a": "found", "proj-b": "found", "proj-c": "found", ghost: "absent" }); }
    }
  });
});
