// Real-Chromium evidence for S2/R6. Not part of `npm test`; Playwright is NOT a repo dependency. See README.md.
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const here = new URL(".", import.meta.url).pathname, out = here + "out/";
mkdirSync(out, { recursive: true });
const esbuild = new URL("../../node_modules/esbuild/bin/esbuild", import.meta.url).pathname;
execFileSync(esbuild, [here + "entry-current.ts", "--bundle", "--format=iife", "--global-name=current", `--outfile=${out}current.js`, "--log-level=error"]);

const PORT = 47831; // fixed: localStorage is per-origin and must survive browser restarts
const page = `<!doctype html><meta charset="utf-8"><title>s2</title><script src="/current.js"></script><body>s2</body>`;
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/s2.html") { res.setHeader("content-type", "text/html"); res.end(page); }
  else if (u === "/sandboxed.html") { res.setHeader("content-type", "text/html"); res.setHeader("content-security-policy", "sandbox allow-scripts"); res.end(page); }
  else if (u === "/current.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(out + "current.js")); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const origin = `http://localhost:${PORT}`;
const RAW = JSON.stringify([{ id: "p1", name: "original", tasks: [] }]);
const results = { chromium: null, origin, scenarios: {}, checks: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); if (!ok) process.exitCode = 1; };

// Page-side helpers (exposed once per page). Stage doubles count calls in sessionStorage-free window state.
const install = (tab) => tab.evaluate(() => {
  window.__calls = { migrate: 0, verifyProfiles: 0, verifyStores: 0 };
  window.ctl = () => current.createCutoverController({
    storage: localStorage,
    stages: {
      migrateProfiles: async () => { __calls.migrate++; return { ok: true }; },
      verifyProfiles: async () => { __calls.verifyProfiles++; return { ok: true }; },
      verifyStores: async () => { __calls.verifyStores++; return { ok: true }; },
      hasDurableState: async () => false
    },
    confirmLegacyWritersQuiesced: () => true // TEST-ONLY: not evidence that any writer stopped
  });
  // Quota helpers. Bulk filler uses many keys (growing one huge value crashed the renderer on the 1 GB sandbox);
  // a small adjustable "zpad" key then makes the free space byte-exact.
  window.fillFull = () => {
    localStorage.setItem("zpad", "");
    let last = null, n = 0;
    for (const step of [1 << 20, 1 << 16]) for (;;) { try { last = "zb" + n++; localStorage.setItem(last, "x".repeat(step)); } catch { last = null; break; } }
    for (let i = n - 1; i >= 0; i--) { if (localStorage.getItem("zb" + i) !== null && localStorage.getItem("zb" + i).length === 1 << 16) { localStorage.removeItem("zb" + i); break; } }
    let pad = "";
    for (const step of [1 << 12, 256, 16, 1]) for (;;) { try { localStorage.setItem("zpad", pad + "x".repeat(step)); pad += "x".repeat(step); } catch { break; } }
    return pad.length;
  };
  window.freeChars = (n) => { const cur = localStorage.getItem("zpad") ?? ""; localStorage.setItem("zpad", cur.slice(0, cur.length - n)); return cur.length - n; };
  window.clearPad = () => { for (const k of Object.keys(localStorage)) if (k === "zpad" || /^zb\d+$/.test(k)) localStorage.removeItem(k); };
});
const fresh = async (ctx) => { const t = await ctx.newPage(); await t.goto(origin + "/s2.html"); await install(t); return t; };
const reset = (tab, seed = true) => tab.evaluate(([raw, seed]) => { localStorage.clear(); if (seed) localStorage.setItem("devmate-workspace-v1", raw); }, [RAW, seed]);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
results.chromium = browser.version();

// ---------- A. two tabs, real Web Locks ----------
{
  const ctx = await browser.newContext();
  const a = await fresh(ctx), b = await fresh(ctx);
  await reset(a);
  const plan = await a.evaluate(() => window.ctl().preflight());
  const both = await Promise.all([a, b].map((t) => t.evaluate((p) => window.ctl().begin(p.plan).then((r) => ({ ok: r.ok, changed: r.ok ? r.changed : null, reason: r.ok ? null : r.reason })), plan)));
  const changedCount = both.filter((r) => r.ok && r.changed).length;
  results.scenarios["A1-begin-race"] = { both, changedCount, markerRaw: await a.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace")) };
  check("A1 exactly one tab declares intent; the other is an idempotent no-op", both.every((r) => r.ok) && changedCount === 1, JSON.stringify(both));
  const resumes = await Promise.all([a, b].map((t) => t.evaluate(() => window.ctl().resume().then((r) => ({ ok: r.ok, mode: r.state.mode, changed: r.ok ? r.changed : null, reason: r.ok ? null : r.reason })))));
  const calls = await Promise.all([a, b].map((t) => t.evaluate(() => window.__calls)));
  const total = calls.reduce((s, c) => ({ migrate: s.migrate + c.migrate, verifyProfiles: s.verifyProfiles + c.verifyProfiles, verifyStores: s.verifyStores + c.verifyStores }), { migrate: 0, verifyProfiles: 0, verifyStores: 0 });
  const finalState = await a.evaluate(() => window.ctl().inspect().mode);
  results.scenarios["A2-resume-race"] = { resumes, total, finalState };
  // Per transition: intent->profiles-verified runs migrateProfiles+verifyProfiles; profiles-verified->stores-verified and
  // stores-verified->committed each run verifyStores (re-verified right before commit). A single tab gives exactly 1/1/2.
  check("A2 concurrent resume ends durable; every transition ran exactly once across both tabs (migrate 1, verifyProfiles 1, verifyStores 2)", resumes.every((r) => r.ok) && finalState === "durable" && total.migrate === 1 && total.verifyProfiles === 1 && total.verifyStores === 2, JSON.stringify({ resumes, total, finalState }));
  await ctx.close();
}

// ---------- B. browser close/reopen after every phase (real persistent profile) ----------
{
  const dir = mkdtempSync(tmpdir() + "/s2-profile-");
  const phases = [];
  const open = async () => { const ctx = await chromium.launchPersistentContext(dir, { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }); const t = ctx.pages()[0] ?? await ctx.newPage(); await t.goto(origin + "/s2.html"); await install(t); return { ctx, t }; };
  let s = await open();
  await reset(s.t);
  const plan = await s.t.evaluate(() => window.ctl().preflight());
  const began = await s.t.evaluate((p) => window.ctl().begin(p.plan).then((r) => r.ok), plan.plan ? plan : plan);
  phases.push({ after: "begin", began });
  await s.ctx.close();
  for (const expected of ["intent", "profiles-verified", "stores-verified", "committed"]) {
    s = await open();
    const st = await s.t.evaluate(() => { const c = window.ctl(); const i = c.inspect(); return { mode: i.mode, phase: i.mode === "recovery" ? i.phase : i.mode === "durable" ? i.marker.phase : null, legacyIntact: localStorage.getItem("devmate-workspace-v1") }; });
    phases.push({ reopenedSeen: st.mode, phase: st.phase, expected, legacyIntact: st.legacyIntact === RAW });
    check(`B reopen sees phase ${expected}`, st.phase === expected && st.legacyIntact === RAW, JSON.stringify(st));
    if (expected !== "committed") { const adv = await s.t.evaluate(() => window.ctl().advance().then((r) => ({ ok: r.ok, changed: r.ok ? r.changed : null }))); phases.push({ advanced: adv }); }
    await s.ctx.close();
  }
  // malformed marker after restart
  s = await open();
  const mal = await s.t.evaluate(() => { localStorage.setItem("devmate-cutover-v1:workspace", "{not json"); const c = window.ctl(); return { inspect: c.inspect(), pre: c.preflight() }; });
  results.scenarios["B-malformed-marker"] = { mode: mal.inspect.mode, reason: mal.inspect.reason, preflightOk: mal.pre.ok, preflightReason: mal.pre.ok ? null : mal.pre.reason };
  check("B malformed marker is indeterminate and blocks a new plan", mal.inspect.mode === "indeterminate" && mal.inspect.reason === "malformed" && mal.pre.ok === false, JSON.stringify(mal.inspect));
  await s.ctx.close();
  rmSync(dir, { recursive: true, force: true });
  results.scenarios["B-restart-every-phase"] = { phases };
}

// ---------- C. real storage quota ----------
{
  const ctx = await browser.newContext();
  const t = await fresh(ctx);
  // C1: quota exhausted before the raw copy -> nothing written, legacy untouched
  await reset(t);
  const full1 = await t.evaluate(() => window.fillFull());
  const plan1 = await t.evaluate(() => window.ctl().preflight());
  const c1 = await t.evaluate((p) => window.ctl().begin(p.plan).then((r) => ({ ok: r.ok, reason: r.ok ? null : r.reason, mode: r.state.mode })), plan1);
  const c1After = await t.evaluate(() => ({ marker: localStorage.getItem("devmate-cutover-v1:workspace"), legacy: localStorage.getItem("devmate-workspace-v1") }));
  results.scenarios["C1-quota-at-raw-copy"] = { paddedChars: full1, result: c1, markerWritten: c1After.marker !== null, legacyIntact: c1After.legacy === RAW };
  check("C1 full storage: begin fails closed (preserve-quota), no marker, legacy intact", c1.ok === false && c1.reason === "preserve-quota" && c1After.marker === null && c1After.legacy === RAW, JSON.stringify(c1));

  // C2: room for the raw copy but not for the marker -> marker-write-failed, then idempotent retry after freeing space
  await reset(t);
  await t.evaluate(() => window.fillFull());
  const need = await t.evaluate(() => { const fp = current.fingerprintSource(localStorage.getItem("devmate-workspace-v1")); const key = current.CUTOVER_SOURCE_COPY_PREFIX + fp; return { copyChars: key.length + localStorage.getItem("devmate-workspace-v1").length }; });
  await t.evaluate((n) => window.freeChars(n), need.copyChars); // exactly the copy, nothing for the marker
  const plan2 = await t.evaluate(() => window.ctl().preflight());
  const c2 = await t.evaluate((p) => window.ctl().begin(p.plan).then((r) => ({ ok: r.ok, reason: r.ok ? null : r.reason, mode: r.state.mode })), plan2.plan ? plan2 : plan2);
  const c2State = await t.evaluate(() => ({ marker: localStorage.getItem("devmate-cutover-v1:workspace"), copies: Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length, mode: window.ctl().inspect().mode }));
  await t.evaluate(() => window.clearPad());
  const c2Retry = await t.evaluate(() => { const c = window.ctl(); const p = c.preflight(); return c.begin(p.plan).then((r) => ({ ok: r.ok, changed: r.ok ? r.changed : null, mode: r.state.mode })); });
  const c2Copies = await t.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length);
  results.scenarios["C2-quota-at-marker"] = { freedChars: need.copyChars, first: c2, stateAfterFailure: c2State, retryAfterFreeingSpace: c2Retry, copiesAfterRetry: c2Copies };
  check("C2 no room for the marker: begin fails, no marker, state stays legacy, raw copy kept", c2.ok === false && c2State.marker === null && c2State.mode === "legacy" && c2State.copies === 1, JSON.stringify({ c2, c2State }));
  check("C2 retry after freeing space succeeds without a second raw copy (R3)", c2Retry.ok === true && c2Retry.changed === true && c2Copies === 1, JSON.stringify({ c2Retry, c2Copies }));

  // C3: phase advance grows the marker; find the exact boundary in a real browser
  await reset(t);
  const p3 = await t.evaluate(() => { const c = window.ctl(); const p = c.preflight(); return c.begin(p.plan).then((r) => r.ok); });
  const lens = await t.evaluate(() => { const cur = JSON.parse(localStorage.getItem("devmate-cutover-v1:workspace")); const a = localStorage.getItem("devmate-cutover-v1:workspace").length; const b = current.serializeMarker({ ...cur, phase: "profiles-verified" }).length; return { intent: a, profilesVerified: b, growth: b - a }; });
  await t.evaluate(() => window.fillFull());
  const rows = [];
  let freedSoFar = 0;
  for (const free of [lens.growth - 1, lens.growth]) {
    await t.evaluate((n) => window.freeChars(n), free - freedSoFar); freedSoFar = free; // cumulative: free chars = `free`
    const r = await t.evaluate(() => window.ctl().advance().then((x) => ({ ok: x.ok, reason: x.ok ? null : x.reason, mode: x.state.mode, markerPhase: JSON.parse(localStorage.getItem("devmate-cutover-v1:workspace")).phase })));
    rows.push({ freeChars: free, ...r });
  }
  results.scenarios["C3-quota-at-phase-advance"] = { intentStarted: p3, markerLengths: lens, rows };
  const failed = rows[0], okRow = rows[1];
  check("C3 marker is NOT fixed-size across phases (intent -> profiles-verified grows)", lens.growth > 0, JSON.stringify(lens));
  check("C3 with growth-1 free chars the advance fails closed and the intent marker is intact", failed.ok === false && failed.markerPhase === "intent" && failed.mode === "recovery", JSON.stringify(failed));
  check("C3 with exactly the growth free the advance succeeds", okRow.ok === true && okRow.markerPhase === "profiles-verified", JSON.stringify(okRow));
  await ctx.close();
}

// ---------- D. storage unavailable (real SecurityError in an opaque-origin sandbox) ----------
{
  const ctx = await browser.newContext();
  const t = await ctx.newPage(); await t.goto(origin + "/sandboxed.html");
  const d = await t.evaluate(() => {
    let access = "ok"; try { void window.localStorage; } catch (e) { access = e.name; }
    const c = current.createCutoverController({ stages: {}, runExclusive: async (w) => ({ ok: true, value: await w() }) });
    const pre = c.preflight();
    return { access, inspectMode: c.inspect().mode, inspectReason: c.inspect().reason ?? null, preflightOk: pre.ok, preflightReason: pre.ok ? null : pre.reason, readState: current.readCutoverState(null).mode };
  });
  results.scenarios["D-storage-unavailable"] = d;
  check("D real SecurityError: state is indeterminate/unreadable and preflight refuses", d.access === "SecurityError" && d.inspectMode === "indeterminate" && d.preflightOk === false && d.preflightReason === "storage-unavailable", JSON.stringify(d));
  await ctx.close();
}

await browser.close(); server.close();
results.allChecksPassed = results.checks.every((c) => c.ok);
writeFileSync(here + "results.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ chromium: results.chromium, allChecksPassed: results.allChecksPassed, checks: results.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`) }, null, 2));
