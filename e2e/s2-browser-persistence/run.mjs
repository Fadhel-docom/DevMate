// S2 real-Chromium persistence/contention evidence for PR-D (R6, and the browser half of R1).
// Not part of `npm test`; Playwright and esbuild are NOT repository dependencies (see README.md).
// Usage: node e2e/s2-browser-persistence/run.mjs [only-scenario-id ...]
import { createRequire } from "node:module";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const esbuild = (() => { for (const id of [process.env.ESBUILD_MODULE, "esbuild", "/opt/npm-tools/node_modules/esbuild"]) { if (!id) continue; try { return require(id); } catch { /* next */ } } throw new Error("esbuild not found; set ESBUILD_MODULE"); })();

const here = new URL(".", import.meta.url).pathname, out = here + "out/";
mkdirSync(out, { recursive: true });
for (const [entry, name, global] of [["entry-current.ts", "cur", "cur"], ["entry-legacy.ts", "leg", "leg"]])
  esbuild.buildSync({ entryPoints: [here + entry], bundle: true, format: "iife", globalName: global, outfile: `${out}${name}.js`, logLevel: "error" });

const PORT = Number(process.env.S2_PORT ?? 18765);
const origin = `http://localhost:${PORT}`;
const html = (title, scripts) => `<!doctype html><meta charset="utf-8"><title>${title}</title>${scripts.map((s) => `<script src="/${s}.js"></script>`).join("")}<body>${title}</body>`;
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  const send = (type, body) => { res.setHeader("content-type", type); res.setHeader("cache-control", "no-store"); res.end(body); };
  if (u === "/new.html") send("text/html", html("new", ["cur"]));
  else if (u === "/old.html") send("text/html", html("old", ["leg"]));
  else if (u === "/p2.html") send("text/html", html("p2", []));
  else if (u === "/sandbox.html") send("text/html", `<!doctype html><title>sandbox</title><iframe id="f" sandbox="allow-scripts" srcdoc="${html("sandboxed", []).replace(/"/g, "&quot;")}<script src='${origin}/cur.js'></script><script src='${origin}/leg.js'></script>"></iframe>`);
  else if (u === "/cur.js" || u === "/leg.js") send("text/javascript", readFileSync(out + u.slice(1)));
  else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="))?.slice(6) ?? null;
const git = (...a) => { try { return execFileSync("git", a, { cwd: here + "../..", encoding: "utf8" }).trim(); } catch { return null; } };
const harnessHead = git("rev-parse", "HEAD");
const parentHead = git("rev-parse", "HEAD^");
if (!harnessHead || !parentHead) throw new Error("The harness requires a full checkout with HEAD and its parent available.");
const srcDiffFromParent = git("diff", "--stat", `${parentHead}..${harnessHead}`, "--", "src");
if (srcDiffFromParent === null) throw new Error("Could not verify whether this PR changes src/.");
const sourceBlobs = Object.fromEntries(["src/storage.ts", "src/cutoverController.ts", "src/cutoverState.ts", "src/__fixtures__/legacyStorage.base.ts"].map((path) => [path, git("rev-parse", `${harnessHead}:${path}`)]));
if (Object.values(sourceBlobs).some((sha) => !sha)) throw new Error("Could not resolve all production source blobs used by this harness.");
const dirty = git("status", "--porcelain", "--", "src", "package.json", "e2e/s2-browser-persistence");
if (dirty === null) throw new Error("Could not inspect the harness working tree.");
const results = {
  meta: {
    codeUnderTest: { commit: harnessHead, parent: parentHead, sourceBlobs, legacyFixtureBase: "3c60a8529ae99d869c3c98970c2df9ff37895d42" },
    srcDiffFromParent: srcDiffFromParent || "(empty: this PR changes no src/ files)",
    harnessHead, harnessDirty: dirty || "(clean)",
    node: process.version, playwright: require("playwright/package.json").version, esbuild: esbuild.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, startedAt: new Date().toISOString(), origin: `http://localhost:${PORT}`
  },
  scenarios: []
};

const RAW = JSON.stringify([
  { id: "p1", name: "Alpha", tasks: [{ id: "t1", title: "first", done: false, createdAt: 1 }] },
  { id: "p2", name: "Beta", tasks: [] }
]);
const OTHER = JSON.stringify([{ id: "p9", name: "older-backup", tasks: [] }]);
const RECOVERED = JSON.stringify([{ id: "p1", name: "Alpha", tasks: [{ id: "t1", title: "first", done: false, createdAt: 1 }, { bad: true }] }]);

let browser, channelUsed;
async function launchBrowser() {
  for (const opts of [{ channel: "chromium" }, {}]) {
    try { const b = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...opts }); channelUsed = opts.channel ?? "chromium-headless-shell (default)"; return b; } catch (e) { results.meta.launchNote = String(e.message).split("\n")[0]; }
  }
  throw new Error("Chromium cannot be launched");
}
browser = await launchBrowser();
results.meta.chromium = browser.version(); results.meta.browserBuild = channelUsed;
results.meta.userAgent = await (async () => { const c = await browser.newContext(); const p = await c.newPage(); const ua = await p.evaluate(() => navigator.userAgent); await c.close(); return ua; })();

async function scenario(id, title, expected, steps, fn) {
  if (only.length && !only.includes(id)) return;
  const s = { id, title, expected, steps, checks: [], evidence: {}, notTested: [] };
  const t0 = Date.now();
  process.stdout.write(`${id} ${title} ... `);
  try { await fn(s); } catch (e) { s.error = String(e?.stack ?? e).slice(0, 1800); }
  s.durationMs = Date.now() - t0;
  s.status = s.error ? "ERROR" : s.forceStatus ? s.forceStatus : s.checks.every((c) => c.pass) ? "PASS" : "FAIL";
  results.scenarios.push(s);
  console.log(`${s.status} (${s.checks.filter((c) => c.pass).length}/${s.checks.length}, ${s.durationMs} ms)`);
  for (const c of s.checks.filter((c) => !c.pass)) console.log(`   FAILED CHECK: ${c.desc} -> ${JSON.stringify(c.observed)?.slice(0, 300)}`);
  if (s.error) console.log("   " + s.error.split("\n")[0]);
}
const check = (s, desc, pass, observed) => { s.checks.push({ desc, pass: !!pass, observed }); return !!pass; };
const tab = async (ctx, kind) => { const p = await ctx.newPage(); await p.goto(`${origin}/${kind}.html`); return p; };
const seed = (p, raw = RAW) => p.evaluate((raw) => localStorage.setItem("devmate-workspace-v1", raw), raw);
const dump = (p) => p.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
const keysOf = (d) => Object.keys(d).filter((k) => !k.startsWith("__fill")).sort();
const MARKER = "devmate-cutover-v1:workspace", LEGACY = "devmate-workspace-v1", BK = "devmate-workspace-v1.unreadable-backup";
const phaseOf = (raw) => { try { return raw ? JSON.parse(raw).phase : null; } catch { return "unparseable"; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summarize = (r) => (r && typeof r === "object") ? { ok: r.ok, reason: r.reason, changed: r.changed, mode: r.state?.mode, stateReason: r.state?.reason, divergentPreserved: r.divergentPreserved } : r;
const PHASES = ["intent", "profiles-verified", "stores-verified", "committed"];
/** Poll a reader tab until `pred(value)` holds. Reports the FIRST (immediate) read and the settled read separately: a stale immediate read is a measurement, not a harness error. */
const settle = async (p, read, pred, arg, ms = 3000) => {
  const t0 = Date.now(); let first, v;
  for (;;) {
    v = await p.evaluate(read, arg); if (first === undefined) first = v;
    if (pred(v)) return { value: v, immediate: first, immediateAlreadyTrue: pred(first), settledMs: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { value: v, immediate: first, immediateAlreadyTrue: pred(first), settledMs: null };
    await sleep(5);
  }
};

// ------------------------------------------------------------------ S2-01
await scenario("S2-01", "Lifecycle baseline with the real production stages in real Chromium", "legacy -> intent -> profiles-verified -> stores-verified -> committed; legacy bytes untouched; current writers refused",
  ["seed legacy workspace", "preflight + begin + 3x advance with createCutoverStages() (real profile/ledger stores)", "after each step read the marker", "call the three CURRENT mutators"], async (s) => {
    const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a);
    const r = await a.evaluate(async (RAW) => {
      const c = cur.makeController(); const plan = c.preflight(); const log = [{ step: "preflight", ok: plan.ok }];
      const b = await c.begin(plan.plan); log.push({ step: "begin", ok: b.ok, phase: cur.markerPhase() });
      for (let i = 0; i < 3; i++) { const x = await c.advance(); log.push({ step: "advance", ok: x.ok, phase: cur.markerPhase() }); }
      const projects = JSON.parse(RAW);
      return {
        log, inspect: c.inspect().mode, legacyUnchanged: localStorage.getItem("devmate-workspace-v1") === RAW, exported: c.exportPreservedSource().raw === RAW,
        save: cur.storage.saveProjects(projects, localStorage, RAW).reason, restore: (await cur.storage.restoreBackup(cur.storage.BACKUP_KEY, localStorage)).reason, del: (await cur.storage.deleteBackup(cur.storage.BACKUP_KEY, localStorage)).reason
      };
    }, RAW);
    s.evidence = r;
    check(s, "marker phases are exactly intent, profiles-verified, stores-verified, committed", JSON.stringify(r.log.filter((x) => x.phase).map((x) => x.phase)) === JSON.stringify(PHASES), r.log);
    check(s, "inspect() reports durable", r.inspect === "durable", r.inspect);
    check(s, "legacy bytes unchanged and preserved copy equals the original", r.legacyUnchanged && r.exported, { unchanged: r.legacyUnchanged, exported: r.exported });
    check(s, "all three CURRENT mutators refuse with cutover-active", r.save === "cutover-active" && r.restore === "cutover-active" && r.del === "cutover-active", [r.save, r.restore, r.del]);
    await ctx.close();
  });

// ------------------------------------------------------------------ S2-02
await scenario("S2-02", "Two tabs race to declare intent (real Web Locks)", "exactly one tab writes the intent marker; the other is idempotent; one preserved copy",
  ["60 trials: fresh context, two tabs", "both preflight the same source, then both begin() at the same wall-clock instant", "every marker/preserved-copy getItem/setItem is traced with a microsecond wall-clock stamp (read-only logging wrapper around the real Storage methods; values are logged as null / length)"], async (s) => {
    const trials = [];
    const TRACE = `(() => { const M = "devmate-cutover-v1:workspace", P = "devmate-cutover-v1:source:", g = Storage.prototype.getItem, st = Storage.prototype.setItem; window.__tr = [];
      const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
      Storage.prototype.getItem = function (k) { const v = g.call(this, k); if (this === localStorage && (k === M || k.startsWith(P))) window.__tr.push({ t: now(), op: "get", key: k === M ? "marker" : "copy", value: v === null ? null : v.length }); return v; };
      Storage.prototype.setItem = function (k, v) { const r = st.call(this, k, v); if (this === localStorage && (k === M || k.startsWith(P))) window.__tr.push({ t: now(), op: "set", key: k === M ? "marker" : "copy", value: v.length }); return r; }; })()`;
    for (let i = 0; i < 60; i++) {
      const ctx = await browser.newContext(); const [a, b] = [await tab(ctx, "new"), await tab(ctx, "new")]; await seed(a);
      await a.evaluate(TRACE); await b.evaluate(TRACE);
      const t0 = Date.now() + 200;
      const run = (p) => p.evaluate(async (t0) => { const c = cur.makeController(); const plan = c.preflight(); await new Promise((r) => setTimeout(r, Math.max(0, t0 - Date.now()))); window.__tr.length = 0; const r = await c.begin(plan.plan); return { ok: r.ok, changed: r.changed, reason: r.reason }; }, t0);
      const [ra, rb] = await Promise.all([run(a), run(b)]);
      const d = await dump(a); const trace = { a: await a.evaluate(() => window.__tr), b: await b.evaluate(() => window.__tr) };
      trials.push({ ra, rb, phase: phaseOf(d[MARKER]), copies: Object.keys(d).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length, startedAt: (() => { try { return JSON.parse(d[MARKER]).startedAt; } catch { return null; } })(), trace });
      await ctx.close();
    }
    const changedCounts = trials.map((t) => Number(!!t.ra.changed) + Number(!!t.rb.changed));
    // A "stale read" = tab X reads the marker as null AFTER tab Y's marker write finished (microsecond wall clock, same machine).
    const staleMarkerReads = (t) => { const sets = [...t.trace.a.filter((e) => e.op === "set" && e.key === "marker").map((e) => ({ tab: "a", t: e.t })), ...t.trace.b.filter((e) => e.op === "set" && e.key === "marker").map((e) => ({ tab: "b", t: e.t }))].sort((x, y) => x.t - y.t); if (!sets.length) return []; const first = sets[0]; const other = first.tab === "a" ? t.trace.b : t.trace.a; return other.filter((e) => e.op === "get" && e.key === "marker" && e.value === null && e.t > first.t).map((e) => ({ readAfterFirstWriteByMs: +(e.t - first.t).toFixed(3) })); };
    const bad = trials.map((t, i) => ({ i, t })).filter(({ t }) => Number(!!t.ra.changed) + Number(!!t.rb.changed) !== 1);
    s.evidence = { trials: trials.length, changedTrueCountDistribution: changedCounts.reduce((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {}), doubleWriteTrials: bad.length, doubleWriteDiagnosis: bad.slice(0, 4).map(({ i, t }) => ({ trial: i, ra: t.ra, rb: t.rb, staleNullMarkerReadsAfterTheOtherTabsWrite: staleMarkerReads(t), markerSetsPerTab: { a: t.trace.a.filter((e) => e.op === "set" && e.key === "marker").length, b: t.trace.b.filter((e) => e.op === "set" && e.key === "marker").length }, copyWrites: [...t.trace.a, ...t.trace.b].filter((e) => e.op === "set" && e.key === "copy").length })), sample: trials.slice(0, 1).map(({ trace, ...rest }) => rest) };
    check(s, "every trial: both begin() calls ok", trials.every((t) => t.ra.ok && t.rb.ok), trials.filter((t) => !(t.ra.ok && t.rb.ok)));
    check(s, "every trial: exactly one tab reports changed:true", changedCounts.every((n) => n === 1), s.evidence.changedTrueCountDistribution);
    check(s, "every trial: marker is intent and exactly one preserved copy exists", trials.every((t) => t.phase === "intent" && t.copies === 1), trials.filter((t) => !(t.phase === "intent" && t.copies === 1)));
  });

// ------------------------------------------------------------------ S2-03
await scenario("S2-03", "Three tabs resume() concurrently with real stages; an observer tab logs storage events", "marker moves strictly forward, each phase value written once, all tabs converge on durable",
  ["15 trials: observer + 3 worker tabs", "worker A reaches intent", "all three workers call resume() at the same instant", "observer records every marker value from storage events"], async (s) => {
    const trials = [];
    for (let i = 0; i < 15; i++) {
      const ctx = await browser.newContext(); const obs = await tab(ctx, "new"); const ws = [await tab(ctx, "new"), await tab(ctx, "new"), await tab(ctx, "new")];
      await obs.evaluate(() => { window.__log = []; addEventListener("storage", (e) => { if (e.key === "devmate-cutover-v1:workspace") window.__log.push(e.newValue); }); });
      await seed(ws[0]);
      await ws[0].evaluate(async () => { const c = cur.makeController(); const p = c.preflight(); await c.begin(p.plan); });
      const t0 = Date.now() + 200;
      const rs = await Promise.all(ws.map((p) => p.evaluate(async (t0) => { const c = cur.makeController(); await new Promise((r) => setTimeout(r, Math.max(0, t0 - Date.now()))); const r = await c.resume(); return { ok: r.ok, changed: r.changed, mode: r.state?.mode, reason: r.reason }; }, t0)));
      await sleep(100);
      const log = (await obs.evaluate(() => window.__log)).map(phaseOf);
      const modes = await Promise.all(ws.map((p) => p.evaluate(() => cur.makeController().inspect().mode)));
      trials.push({ rs, log, modes });
      await ctx.close();
    }
    const ordered = (log) => log.every((p, i) => i === 0 || PHASES.indexOf(p) > PHASES.indexOf(log[i - 1]));
    s.evidence = { trials: trials.length, sample: trials.slice(0, 2) };
    check(s, "every resume() returned ok", trials.every((t) => t.rs.every((r) => r.ok)), trials.filter((t) => !t.rs.every((r) => r.ok)).slice(0, 2));
    check(s, "observed marker values (from the other tab) are strictly increasing phases, no repeat, no regression", trials.every((t) => ordered(t.log)), trials.filter((t) => !ordered(t.log)).slice(0, 2));
    check(s, "the last observed marker value is committed in every trial", trials.every((t) => t.log.at(-1) === "committed"), trials.map((t) => t.log.at(-1)));
    check(s, "all three tabs report durable afterwards", trials.every((t) => t.modes.every((m) => m === "durable")), trials.filter((t) => !t.modes.every((m) => m === "durable")).slice(0, 2));
  });

// ------------------------------------------------------------------ S2-04
await scenario("S2-04", "Web Locks mutual exclusion and visibility (real), with an unlocked control", "with the lock no update is lost; query() shows 1 held + N pending",
  ["3 tabs x 30 read-yield-write increments of one counter key WITH withStorageLock", "same WITHOUT a lock (control)", "one tab holds the lock, two request it, a fourth tab calls navigator.locks.query()"], async (s) => {
    const ctx = await browser.newContext(); const ts = [await tab(ctx, "new"), await tab(ctx, "new"), await tab(ctx, "new")];
    const work = (useLock) => Promise.all(ts.map((p) => p.evaluate(async (useLock) => {
      let failed = 0;
      for (let i = 0; i < 30; i++) {
        const op = async () => { const v = Number(localStorage.getItem("ctr") ?? "0"); await new Promise((r) => setTimeout(r, 0)); localStorage.setItem("ctr", String(v + 1)); };
        if (useLock) { const r = await cur.storage.withStorageLock(op, { timeoutMs: 60000 }); if (!r.ok) failed++; } else await op();
      }
      return failed;
    }, useLock)));
    await ts[0].evaluate(() => localStorage.setItem("ctr", "0")); const lockedFailed = await work(true); const withLock = Number(await ts[0].evaluate(() => localStorage.getItem("ctr")));
    await ts[0].evaluate(() => localStorage.setItem("ctr", "0")); await work(false); const without = Number(await ts[0].evaluate(() => localStorage.getItem("ctr")));
    await ts[0].evaluate(() => { window.__h = cur.storage.withStorageLock(() => new Promise((r) => { window.__rel = r; }), { timeoutMs: 60000 }); });
    await ts[1].evaluate(() => { window.__p = cur.storage.withStorageLock(async () => 1, { timeoutMs: 60000 }); });
    await ts[2].evaluate(() => { window.__p = cur.storage.withStorageLock(async () => 1, { timeoutMs: 60000 }); });
    await sleep(300);
    const q = await (await tab(ctx, "new")).evaluate(async () => { const x = await navigator.locks.query(); return { held: x.held.map((l) => [l.name, l.mode]), pending: x.pending.map((l) => [l.name, l.mode]) }; });
    await ts[0].evaluate(() => window.__rel()); await sleep(200);
    s.evidence = { expected: 90, withLock, withoutLockControl: without, lostUpdatesWithoutLock: 90 - without, lockFailures: lockedFailed, query: q };
    check(s, "with the real lock the counter is exactly 90 (no lost update) and no request failed", withLock === 90 && lockedFailed.every((n) => n === 0), s.evidence);
    check(s, "navigator.locks.query() shows one held and two pending exclusive requests for the storage lock", q.held.length === 1 && q.pending.length === 2 && [...q.held, ...q.pending].every(([n, m]) => n === "devmate-workspace-v1" && m === "exclusive"), q);
    s.notTested.push("The unlocked control is informational: its lost-update count varies by run and is not an assertion.");
    await ctx.close();
  });

// ------------------------------------------------------------------ S2-05
await scenario("S2-05", "Lock timeout, then holder death releases the lock (real tabs)", "begin() gives lock-timeout after ~8 s and writes nothing; closing the holder lets the next attempt succeed",
  ["tab H holds the storage lock", "tab C preflights and calls begin() (default 8000 ms lock timeout)", "close H", "C calls begin() again"], async (s) => {
    const ctx = await browser.newContext(); const h = await tab(ctx, "new"), c = await tab(ctx, "new"); await seed(c);
    await h.evaluate(() => { navigator.locks.request("devmate-workspace-v1", { mode: "exclusive" }, () => new Promise((r) => { window.__rel = r; })); });
    await sleep(150);
    const first = await c.evaluate(async () => { const k = cur.makeController(); const p = k.preflight(); const t = performance.now(); const r = await k.begin(p.plan); return { r: { ok: r.ok, reason: r.reason }, waitedMs: Math.round(performance.now() - t) }; });
    const d1 = await dump(c);
    await h.close({ runBeforeUnload: false }); await sleep(100);
    const second = await c.evaluate(async () => { const k = cur.makeController(); const p = k.preflight(); const t = performance.now(); const r = await k.begin(p.plan); return { r: { ok: r.ok, changed: r.changed, reason: r.reason }, waitedMs: Math.round(performance.now() - t), q: await navigator.locks.query().then((x) => x.held.length) }; });
    s.evidence = { whileHeld: first, afterHolderClosed: second, markerAfterTimeout: d1[MARKER] ?? null, copiesAfterTimeout: Object.keys(d1).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length };
    check(s, "while held: lock-timeout after roughly 8 s (7.5-9.5 s)", first.r.reason === "lock-timeout" && first.waitedMs > 7500 && first.waitedMs < 9500, first);
    check(s, "the timed-out begin() wrote neither marker nor preserved copy", !d1[MARKER] && s.evidence.copiesAfterTimeout === 0, s.evidence);
    check(s, "after the holder tab closed, begin() succeeds immediately (< 1 s) and nothing is left held", second.r.ok && second.r.changed && second.waitedMs < 1000 && second.q === 0, second);
    await ctx.close();
  });

// ------------------------------------------------------------------ S2-06
await scenario("S2-06", "Real Chromium localStorage quota exhaustion at each controller write point", "every quota failure is reported, nothing is silently half-advanced, and recovery works once space returns",
  ["(a) storage full at begin()", "(b) room for the preserved copy but not the marker", "(c) marker written, then storage full during the real stage writes", "(d) room for stages (trivial) but not for the longer next-phase marker; then exactly enough", "(e) the OLD writer on a full storage"], async (s) => {
    const okStages = `({ migrateProfiles: async () => ({ ok: true }), verifyProfiles: async () => ({ ok: true }), verifyStores: async () => ({ ok: true }) })`;
    { // (a)
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"); const old = await tab(ctx, "old"); await seed(a);
      const r = await a.evaluate(async (RAW) => {
        const c = cur.makeController(); const plan = c.preflight(); const cap = cur.Q.fillFull();
        const begun = await c.begin(plan.plan); const d = Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover"));
        const stillLegacy = localStorage.getItem("devmate-workspace-v1") === RAW;
        cur.Q.clearFill(); const retry = await c.begin(plan.plan);
        return { capacityWhenFull: cap, begin: { ok: begun.ok, reason: begun.reason }, cutoverKeysAfterFailure: d, stillLegacy, retry: { ok: retry.ok, changed: retry.changed }, phaseAfterRetry: cur.markerPhase() };
      }, RAW);
      s.evidence.a_fullAtBegin = r;
      check(s, "(a) begin() on a full storage fails with preserve-quota and writes no marker/copy", r.begin.reason === "preserve-quota" && r.cutoverKeysAfterFailure.length === 0 && r.stillLegacy, r);
      check(s, "(a) after space is freed the same plan succeeds (intent)", r.retry.ok && r.phaseAfterRetry === "intent", r);
      await ctx.close();
    }
    { // (e) old writer on full storage, own context. Filled FROM the old tab itself (see e_crossTab for the cross-tab observation)
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"); const old = await tab(ctx, "old"); await seed(a);
      await old.evaluate(() => leg.oldLoad());
      // cross-tab observation: storage filled by tab A, can tab OLD still store 20 KB?
      await a.evaluate(() => cur.Q.fillFull());
      await sleep(500);
      const cross = await old.evaluate(() => { let ok = false; try { localStorage.setItem("__probe", "x".repeat(20000)); ok = true; } catch { /* quota */ } try { localStorage.removeItem("__probe"); } catch { /* ignore */ } return { oldTabCanStore20KBAfterOtherTabFilledStorage: ok }; });
      s.evidence.e_crossTab = cross;
      await ctx.close();
      } { // (e2) fresh context: nothing carried over from the cross-tab probe
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"); const old = await tab(ctx, "old"); await seed(a); await sleep(300);
      await old.evaluate(() => leg.oldLoad());
      await old.evaluate(() => { for (const size of [200000, 20000, 2000, 200, 20, 1]) for (let i = 0; ; i++) { try { localStorage.setItem(`__fill:${size}:${i}`, "x".repeat(size)); } catch { break; } } });
      const r = await old.evaluate(async (RAW) => { const w = await leg.oldAutosave("old-on-full-storage-" + "x".repeat(20000)); return { ok: w.ok, reason: w.reason, unchanged: localStorage.getItem("devmate-workspace-v1") === RAW }; }, RAW);
      s.evidence.e_oldWriterOnFullStorage = r;
      check(s, "(e) the old writer, filling storage itself so its new payload cannot fit, reports a failure and leaves the workspace byte-identical", r.ok === false && r.unchanged, r);
      await ctx.close();
    }
    { // (b)
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a);
      const r = await a.evaluate(async (RAW) => {
        const c = cur.makeController(); const plan = c.preflight(); const copyKey = cur.CUTOVER_SOURCE_COPY_PREFIX + cur.fingerprintSource(RAW);
        cur.Q.fillFull(); const need = cur.Q.needFor(copyKey, RAW); const cap = cur.Q.setCapacity(need + 5);
        const begun = await c.begin(plan.plan); const keys = Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover"));
        const state = cur.readCutoverState(localStorage).mode; cur.Q.clearFill(); const retry = await c.begin(plan.plan);
        return { copyNeed: need, capacityWhenTried: cap, begin: { ok: begun.ok, reason: begun.reason, message: begun.message }, cutoverKeysAfterFailure: keys, stateAfterFailure: state, retry: { ok: retry.ok, changed: retry.changed }, phaseAfterRetry: cur.markerPhase() };
      }, RAW);
      s.evidence.b_copyFitsMarkerDoesNot = r;
      check(s, "(b) begin() fails with marker-write-failed; the preserved copy exists, no marker; state is still legacy", r.begin.reason === "marker-write-failed" && r.cutoverKeysAfterFailure.length === 1 && r.stateAfterFailure === "legacy", r);
      check(s, "(b) retry after freeing space is idempotent for the existing copy and reaches intent", r.retry.ok && r.phaseAfterRetry === "intent", r);
      await ctx.close();
    }
    { // (c)
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a);
      const r = await a.evaluate(async () => {
        const c = cur.makeController(); const plan = c.preflight(); await c.begin(plan.plan);
        const before = Object.keys(localStorage).sort(); cur.Q.fillFull(); const cap = cur.Q.setCapacity(5);
        const adv = await c.advance(); const markerAfter = cur.markerPhase(); const after = Object.keys(localStorage).filter((k) => !k.startsWith("__fill")).sort();
        cur.Q.clearFill(); const resumed = await c.resume();
        return { capacityWhenTried: cap, advance: { ok: adv.ok, reason: adv.reason, stageReason: adv.stageReason }, markerAfterFailure: markerAfter, newKeysLeftByFailedStage: after.filter((k) => !before.includes(k)), resume: { ok: resumed.ok, mode: resumed.state?.mode }, finalPhase: cur.markerPhase(), inspect: c.inspect().mode };
      });
      s.evidence.c_quotaDuringRealStages = r;
      check(s, "(c) advance() reports stage-failed and the marker does not move", r.advance.reason === "stage-failed" && r.markerAfterFailure === "intent", r);
      check(s, "(c) after space returns, resume() reaches committed and inspect() is durable", r.resume.ok && r.finalPhase === "committed" && r.inspect === "durable", r);
    }
    { // (d)
      for (const [label, free, expectOk] of [["fails", 5, false], ["succeeds", 11, true]]) {
        const ctx2 = await browser.newContext(); const b = await tab(ctx2, "new"); await seed(b);
        const r2 = await b.evaluate(async ([okStages, free]) => {
          const stages = eval(okStages); const c = cur.makeController({ stages }); const plan = c.preflight(); await c.begin(plan.plan);
          const markerBefore = localStorage.getItem("devmate-cutover-v1:workspace"); cur.Q.fillFull();
          const growth = JSON.stringify({ ...JSON.parse(markerBefore), phase: "profiles-verified" }).length - markerBefore.length;
          const cap = cur.Q.setCapacity(free); const adv = await c.advance();
          return { markerGrowthChars: growth, capacityWhenTried: cap, advance: { ok: adv.ok, reason: adv.reason }, markerUnchanged: localStorage.getItem("devmate-cutover-v1:workspace") === markerBefore, phase: cur.markerPhase(), inspect: c.inspect().mode };
        }, [okStages, free]);
        s.evidence[`d_nextPhaseMarker_${label}`] = r2;
        if (expectOk) check(s, `(d) with exactly the growth available (${r2.markerGrowthChars} chars, tried ${r2.capacityWhenTried}) the advance succeeds`, r2.advance.ok && r2.phase === "profiles-verified", r2);
        else check(s, `(d) with less space than the growth (${r2.markerGrowthChars} chars, tried ${r2.capacityWhenTried}) advance fails with marker-write-failed and the marker bytes are unchanged`, r2.advance.reason === "marker-write-failed" && r2.markerUnchanged && r2.phase === "intent" && r2.inspect === "recovery", r2);
        await ctx2.close();
      }
    }
    s.notTested.push("Quota behaviour of other browsers; the quota size is Chromium's, measured here by probing, not assumed.");
  });

// ------------------------------------------------------------------ S2-07
await scenario("S2-07", "Storage genuinely blocked (sandboxed opaque-origin iframe: real SecurityError)", "controller and writers report unavailability and never throw; nothing is written",
  ["load the real bundles inside <iframe sandbox=\"allow-scripts\">", "touch localStorage and navigator.locks", "run controller, current writer and old writers with default storage"], async (s) => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(`${origin}/sandbox.html`);
    await page.waitForFunction(() => document.getElementById("f")?.contentWindow !== null); await sleep(300);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    const r = await frame.evaluate(async () => {
      const o = {}; try { o.localStorage = typeof localStorage; } catch (e) { o.localStorageError = e.name; }
      try { o.locks = typeof navigator.locks; } catch (e) { o.locksError = e.name; }
      const c = cur.createCutoverController({ stages: cur.createCutoverStages(), confirmLegacyWritersQuiesced: () => true });
      o.inspect = c.inspect(); o.preflight = c.preflight().reason; o.begin = (await c.begin({ sourceRaw: null, fingerprint: "absent" })).reason;
      try { o.currentSave = cur.storage.saveProjects([], undefined, undefined).reason; } catch (e) { o.currentSaveThrew = e.name; }
      try { o.oldSave = leg.saveProjects([], undefined, undefined).reason; } catch (e) { o.oldSaveThrew = e.name; }
      try { o.oldSaveLocked = (await leg.saveProjectsLocked([], undefined, undefined)).reason; } catch (e) { o.oldSaveLockedThrew = e.name; }
      return o;
    });
    s.evidence = r;
    check(s, "localStorage access really throws SecurityError in this frame", r.localStorageError === "SecurityError", r);
    check(s, "controller: inspect() indeterminate/unreadable, begin() storage-unavailable, nothing thrown", r.inspect.mode === "indeterminate" && r.inspect.reason === "unreadable" && r.begin === "storage-unavailable", r);
    check(s, "current and old writers return failures instead of throwing", !r.currentSaveThrew && !r.oldSaveThrew && !r.oldSaveLockedThrew, r);
  });

// ------------------------------------------------------------------ S2-08
await scenario("S2-08", "Marker read failure, write failure and write-then-unreadable (FAULT INJECTION at the Storage API boundary)", "fail closed, never write a wrong marker, never report success that did not happen; recovery on retry",
  ["page-level patch of Storage.prototype getItem/setItem that throws ONLY for the marker key; the real controller and real current writers run unmodified", "5 sub-cases"], async (s) => {
    const install = `(() => {
      const M = "devmate-cutover-v1:workspace", g = Storage.prototype.getItem, set = Storage.prototype.setItem;
      window.__F = { readAlways: null, readOnNth: 0, readCount: 0, writeFail: false, unreadableAfterWrite: false, wrote: false };
      window.__rawGet = (k) => g.call(localStorage, k);
      Storage.prototype.getItem = function (k) { if (this === localStorage && k === M) { const F = window.__F; F.readCount++; if (F.readAlways || (F.readOnNth && F.readCount === F.readOnNth) || (F.unreadableAfterWrite && F.wrote)) throw new DOMException("injected marker read failure", F.readAlways ?? "SecurityError"); } return g.call(this, k); };
      Storage.prototype.setItem = function (k, v) { if (this === localStorage && k === M) { const F = window.__F; if (F.writeFail) throw new DOMException("injected marker write failure", "QuotaExceededError"); const r = set.call(this, k, v); if (F.unreadableAfterWrite) F.wrote = true; return r; } return set.call(this, k, v); };
    })()`;
    const fresh = async () => { const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a); await a.evaluate(install); return { ctx, a }; };
    { const { ctx, a } = await fresh(); // 1
      const r = await a.evaluate(async (RAW) => {
        const c = cur.makeController(); const out = {}; const projects = JSON.parse(RAW);
        window.__F.readAlways = "SecurityError"; out.secInspect = c.inspect(); out.secPreflight = c.preflight().reason; out.secBegin = (await c.begin({ sourceRaw: RAW, fingerprint: cur.fingerprintSource(RAW) })).reason; out.secSave = cur.storage.saveProjects(projects, localStorage, RAW).reason;
        window.__F.readAlways = "UnknownError"; out.otherSave = cur.storage.saveProjects(projects, localStorage, RAW).reason; out.otherRestore = (await cur.storage.restoreBackup(cur.storage.BACKUP_KEY, localStorage)).reason; out.otherDelete = (await cur.storage.deleteBackup(cur.storage.BACKUP_KEY, localStorage)).reason;
        window.__F.readAlways = null; out.markerWritten = window.__rawGet("devmate-cutover-v1:workspace"); out.legacyUnchanged = localStorage.getItem("devmate-workspace-v1") === RAW; out.copies = Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length; return out;
      }, RAW);
      s.evidence.case1_markerReadFails = r;
      check(s, "1: marker unreadable -> inspect indeterminate/unreadable; begin() refuses (marker-invalid); no marker, no copy, legacy untouched", r.secInspect.mode === "indeterminate" && r.secInspect.reason === "unreadable" && r.secBegin === "marker-invalid" && r.markerWritten === null && r.copies === 0 && r.legacyUnchanged, r);
      check(s, "1: the CURRENT write barrier fails closed (SecurityError -> unavailable, other -> cutover-indeterminate; restore/delete too)", r.secSave === "unavailable" && r.otherSave === "cutover-indeterminate" && r.otherRestore === "cutover-indeterminate" && r.otherDelete === "cutover-indeterminate", r);
      await ctx.close(); }
    { const { ctx, a } = await fresh(); // 2
      const r = await a.evaluate(async () => {
        const c = cur.makeController(); const plan = c.preflight(); window.__F.writeFail = true; const failed = await c.begin(plan.plan);
        const out = { begin: { ok: failed.ok, reason: failed.reason }, marker: window.__rawGet("devmate-cutover-v1:workspace"), copies: Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length, mode: c.inspect().mode };
        window.__F.writeFail = false; const retry = await c.begin(plan.plan); out.retry = { ok: retry.ok, changed: retry.changed }; out.phase = cur.markerPhase(); return out;
      });
      s.evidence.case2_markerWriteFails = r;
      check(s, "2: begin() reports marker-write-failed, no marker exists, one preserved copy remains, state legacy", r.begin.reason === "marker-write-failed" && r.marker === null && r.copies === 1 && r.mode === "legacy", r);
      check(s, "2: retry after the fault clears reaches intent without duplicating the copy", r.retry.ok && r.phase === "intent", r);
      await ctx.close(); }
    { const { ctx, a } = await fresh(); // 3
      const r = await a.evaluate(async () => {
        const c = cur.makeController(); const plan = c.preflight(); window.__F.unreadableAfterWrite = true; const r1 = await c.begin(plan.plan);
        const out = { begin: { ok: r1.ok, reason: r1.reason }, markerReallyStored: window.__rawGet("devmate-cutover-v1:workspace") !== null };
        window.__F.unreadableAfterWrite = false; out.inspect = c.inspect().mode; const again = await c.begin(plan.plan); out.again = { ok: again.ok, changed: again.changed }; return out;
      });
      s.evidence.case3_writeSucceedsReadBackFails = r;
      check(s, "3: begin() reports marker-verify-failed although the marker IS stored (the report is conservative, not wrong in the dangerous direction)", r.begin.reason === "marker-verify-failed" && r.markerReallyStored, r);
      check(s, "3: once readable, inspect() = recovery and a repeated begin() is idempotent (changed:false)", r.inspect === "recovery" && r.again.ok && r.again.changed === false, r);
      await ctx.close(); }
    { const { ctx, a } = await fresh(); // 4
      const r = await a.evaluate(async () => {
        const c = cur.makeController(); const plan = c.preflight(); await c.begin(plan.plan); const keysBefore = Object.keys(localStorage).sort();
        window.__F.readOnNth = window.__F.readCount + 2; const adv = await c.advance(); const out = { advance: { ok: adv.ok, reason: adv.reason }, phase: cur.markerPhase(), newKeysFromStage: Object.keys(localStorage).sort().filter((k) => !keysBefore.includes(k)).length };
        window.__F.readOnNth = 0; const adv2 = await c.advance(); out.retry = { ok: adv2.ok, changed: adv2.changed }; out.phaseAfterRetry = cur.markerPhase(); return out;
      });
      s.evidence.case4_markerReadFailsAfterStage = r;
      check(s, "4: second marker read (after the stage) fails -> marker-invalid, marker did not advance, stage side effects remain", r.advance.reason === "marker-invalid" && r.phase === "intent" && r.newKeysFromStage > 0, r);
      check(s, "4: the retry completes the phase (stage is idempotent)", r.retry.ok && r.phaseAfterRetry === "profiles-verified", r);
      await ctx.close(); }
    { const { ctx, a } = await fresh(); // 5
      const r = await a.evaluate(async () => {
        const c = cur.makeController(); const plan = c.preflight(); await c.begin(plan.plan); const before = window.__rawGet("devmate-cutover-v1:workspace");
        window.__F.writeFail = true; const adv = await c.advance(); const out = { advance: { ok: adv.ok, reason: adv.reason }, markerUnchanged: window.__rawGet("devmate-cutover-v1:workspace") === before, inspect: c.inspect().mode };
        window.__F.writeFail = false; const adv2 = await c.advance(); out.retry = { ok: adv2.ok }; out.phaseAfterRetry = cur.markerPhase(); return out;
      });
      s.evidence.case5_markerWriteFailsAtAdvance = r;
      check(s, "5: advance() reports marker-write-failed; marker bytes unchanged; inspect() = recovery", r.advance.reason === "marker-write-failed" && r.markerUnchanged && r.inspect === "recovery", r);
      check(s, "5: retry after the fault clears advances", r.retry.ok && r.phaseAfterRetry === "profiles-verified", r);
      await ctx.close(); }
    s.notTested.push("These faults are injected at Storage.prototype for ONE key; the genuine whole-storage failures are S2-06 (quota) and S2-07 (SecurityError).");
  });

// ------------------------------------------------------------------ S2-09 / S2-10 helpers
const persistent = async (dir) => chromium.launchPersistentContext(dir, { headless: true, args: ["--no-sandbox"], ...(channelUsed === "chromium" ? { channel: "chromium" } : {}) });
const killTree = (dir) => { try { const pids = execFileSync("pgrep", ["-f", "--", `user-data-dir=${dir}`], { encoding: "utf8" }).split("\n").filter(Boolean); for (const pid of pids) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } } return pids.length; } catch { return 0; } };

await scenario("S2-09", "Real browser restart at every lifecycle phase (persistent profile, clean exit, relaunch)", "all storage bytes survive the restart; inspect() reports the phase's state; resume() completes to committed",
  ["for each of: no marker, intent, profiles-verified, stores-verified, committed", "launch persistent context, seed, drive the real controller to the phase", "dump all localStorage, close the browser, relaunch with the same profile directory", "dump again and compare; inspect(); resume()"], async (s) => {
    const rows = [];
    for (const phase of ["legacy", ...PHASES]) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "s2-restart-")); let ctx = await persistent(dir); let p = await ctx.newPage(); await p.goto(`${origin}/new.html`); await seed(p);
      if (phase !== "legacy") { const d = await p.evaluate((ph) => cur.driveTo(ph), phase); if (!d.ok) throw new Error("drive failed " + JSON.stringify(d)); }
      const before = await dump(p); await ctx.close();
      ctx = await persistent(dir); p = await ctx.newPage(); await p.goto(`${origin}/new.html`);
      const after = await dump(p);
      const r = await p.evaluate(async ([RAW, phase]) => {
        const c = cur.makeController(); const mode = c.inspect().mode; let preflight = null;
        if (phase === "legacy") { const pl = c.preflight(); preflight = pl.ok; await c.begin(pl.plan); }
        const resumed = await c.resume(); const barrier = cur.storage.saveProjects(JSON.parse(RAW), localStorage, RAW).reason;
        return { modeAfterRestart: mode, preflight, resume: { ok: resumed.ok, mode: resumed.state?.mode }, finalPhase: cur.markerPhase(), legacyUnchanged: localStorage.getItem("devmate-workspace-v1") === RAW, exportedEqualsOriginal: c.exportPreservedSource().raw === RAW, currentWriterAfterCommit: barrier };
      }, [RAW, phase]);
      const identical = JSON.stringify(before) === JSON.stringify(after);
      rows.push({ phase, storageKeys: keysOf(before).length, identicalAfterRestart: identical, ...r });
      await ctx.close(); rmSync(dir, { recursive: true, force: true });
    }
    s.evidence = { rows };
    check(s, "every phase: the complete localStorage dump is byte-identical after the restart", rows.every((r) => r.identicalAfterRestart), rows.filter((r) => !r.identicalAfterRestart).map((r) => r.phase));
    const expectMode = { legacy: "legacy", intent: "recovery", "profiles-verified": "recovery", "stores-verified": "recovery", committed: "durable" };
    check(s, "every phase: inspect() after the restart equals the expected mode (legacy/recovery/recovery/recovery/durable)", rows.every((r) => r.modeAfterRestart === expectMode[r.phase]), rows.map((r) => [r.phase, r.modeAfterRestart]));
    check(s, "every phase: resume() reaches committed; legacy bytes unchanged; preserved copy equals the original", rows.every((r) => r.resume.ok && r.finalPhase === "committed" && r.legacyUnchanged && r.exportedEqualsOriginal), rows);
    check(s, "after restart the current writers stay blocked once a marker exists", rows.filter((r) => r.phase !== "legacy").every((r) => r.currentWriterAfterCommit === "cutover-active"), rows.map((r) => [r.phase, r.currentWriterAfterCommit]));
    s.notTested.push("Clean browser exit only; abrupt kill is S2-10. The real App UI after restart is not run here (see report: React 19 on this host, the repository pins 18).");
  });

await scenario("S2-10", "Process crash (SIGKILL) after cutover writes, then relaunch: what survives, and is it ever inconsistent?", "the pre-crash (flushed) state always survives; recent writes may be lost but never half-lost; after relaunch resume() always reaches committed",
  ["profile 1: seed the legacy workspace (and, for 'resume' trials, drive to intent) and exit the browser CLEANLY so that state is flushed", "profile 2 relaunch: run the real controller call (begin, or resume), wait D ms after it RETURNED, SIGKILL every process of the profile", "profile 3 relaunch: dump, inspect(), then resume()", "separate case: kill while advance() holds the lock inside a stage that never returns"], async (s) => {
    const rel = async (dir) => { const c = await persistent(dir); const p = await c.newPage(); await p.goto(`${origin}/new.html`); return { c, p }; };
    const crashTrial = async (prep, act, delay) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "s2-crash-")); let { c: ctx, p } = await rel(dir); await seed(p);
      if (prep) await p.evaluate((ph) => cur.driveTo(ph), prep);
      await ctx.close();                                                                   // clean exit: flushed baseline
      ({ c: ctx, p } = await rel(dir));
      await p.evaluate((act) => (act === "begin" ? cur.driveTo("intent") : cur.makeController().resume()), act);
      await sleep(delay); const killed = killTree(dir); await sleep(300);
      try { await Promise.race([ctx.close(), sleep(5000)]); } catch { /* already dead */ }
      ({ c: ctx, p } = await rel(dir)); const d = await dump(p);
      const r = await p.evaluate(async () => {
        const c = cur.makeController(); const i = c.inspect(); const phaseBefore = cur.markerPhase(); const profileDataPresent = await cur.createCutoverStages().hasDurableState(); const held = (await navigator.locks.query()).held.length;
        const res = await c.resume(); return { mode: i.mode, reason: i.reason ?? null, phaseBefore, profileDataPresent, locksHeldAfterRelaunch: held, resumeOk: res.ok, final: cur.markerPhase() };
      });
      await ctx.close(); rmSync(dir, { recursive: true, force: true });
      return { act, delayMs: delay, killedProcesses: killed, legacySurvived: d[LEGACY] === RAW, markerSurvived: MARKER in d, preservedCopySurvived: Object.keys(d).some((k) => k.startsWith("devmate-cutover-v1:source:")), ...r };
    };
    const begins = [], resumes = [];
    for (const delay of [0, 1000, 2000, 3000, 4000, 5000, 6000]) for (let i = 0; i < 2; i++) begins.push(await crashTrial(null, "begin", delay));
    for (const delay of [0, 2000, 4000, 6000]) for (let i = 0; i < 2; i++) resumes.push(await crashTrial("intent", "resume", delay));
    const window_ = (rows, key) => Object.fromEntries([...new Set(rows.map((r) => r.delayMs))].map((d) => [d, rows.filter((r) => r.delayMs === d).map((r) => (r[key] ? "kept" : "lost")).join("/")]));
    s.evidence.beginThenKill = { rows: begins, markerSurvivalByDelayMs: window_(begins, "markerSurvived") };
    s.evidence.resumeThenKill = { rows: resumes, finalPhaseBeforeRecoveryByDelayMs: Object.fromEntries([...new Set(resumes.map((r) => r.delayMs))].map((d) => [d, resumes.filter((r) => r.delayMs === d).map((r) => r.phaseBefore).join(" | ")])) };
    const all = [...begins, ...resumes];
    check(s, "every trial really killed the browser (>=1 process matched)", all.every((r) => r.killedProcesses >= 1), all.map((r) => r.killedProcesses));
    check(s, "the flushed baseline (legacy workspace) survives every crash byte-identical", all.every((r) => r.legacySurvived), all.filter((r) => !r.legacySurvived));
    check(s, "never half-written: a surviving marker always has its preserved copy (no marker-without-copy)", begins.every((r) => !r.markerSurvived || r.preservedCopySurvived), begins.filter((r) => r.markerSurvived && !r.preservedCopySurvived));
    check(s, "never ahead of its data: a surviving phase beyond intent always has the migrated profile data", resumes.every((r) => r.phaseBefore === "intent" || r.phaseBefore === null || r.profileDataPresent), resumes.filter((r) => !(r.phaseBefore === "intent" || r.phaseBefore === null || r.profileDataPresent)));
    check(s, "after every crash the state is defined (legacy or recovery, never indeterminate), no lock is left held, and resume()/begin completes to committed", all.every((r) => (r.mode === "legacy" || r.mode === "recovery" || r.mode === "durable") && r.locksHeldAfterRelaunch === 0 && (r.mode === "legacy" || (r.resumeOk && r.final === "committed"))), all.filter((r) => r.mode === "indeterminate" || r.locksHeldAfterRelaunch !== 0));
    { // crash while advance() holds the lock inside a stage that never returns (baseline flushed first)
      const dir = mkdtempSync(path.join(os.tmpdir(), "s2-crash-")); let { c: ctx, p } = await rel(dir); await seed(p); await p.evaluate(() => cur.driveTo("intent")); await ctx.close();
      ({ c: ctx, p } = await rel(dir));
      await p.evaluate(() => { const real = cur.createCutoverStages(); const stages = { ...real, migrateProfiles: async () => { await real.migrateProfiles(); await new Promise(() => {}); return { ok: true }; } }; window.__adv = cur.makeController({ stages }).advance(); });
      await sleep(600); const heldBeforeKill = await p.evaluate(async () => (await navigator.locks.query()).held.map((l) => l.name));
      const killed = killTree(dir); await sleep(300); try { await Promise.race([ctx.close(), sleep(5000)]); } catch { /* dead */ }
      ({ c: ctx, p } = await rel(dir));
      const r = await p.evaluate(async () => { const c = cur.makeController(); const mode = c.inspect().mode; const held = (await navigator.locks.query()).held.length; const res = await c.resume(); return { mode, locksHeldAfterRelaunch: held, resumeOk: res.ok, final: cur.markerPhase(), stateAfter: c.inspect().mode }; });
      s.evidence.crashMidStage = { heldBeforeKill, killed, ...r };
      check(s, "mid-stage crash: the lock was held when killed; after relaunch it is free, state is recovery, resume() reaches committed/durable", heldBeforeKill.includes("devmate-workspace-v1") && r.locksHeldAfterRelaunch === 0 && r.mode === "recovery" && r.resumeOk && r.final === "committed" && r.stateAfter === "durable", s.evidence.crashMidStage);
      await ctx.close(); rmSync(dir, { recursive: true, force: true });
    }
    s.notTested.push("SIGKILL of the browser in a container is not an OS crash or power loss: the OS page cache survives it, so this says nothing about fsync-level durability after a kernel panic.", "A renderer-only crash (page crash, browser alive) was not separately exercised.", "The loss window is measured on this build/host only; it is Chromium's deferred localStorage flush, not a property of the controller, and is not a portable guarantee.");
  });

// ------------------------------------------------------------------ S2-11
await scenario("S2-11", "Cross-tab consistency of the marker (reader tabs vs writer tab)", "all tabs converge; any stale read is measured, not assumed",
  ["30 trials: writer tab declares intent; a second tab reads the marker immediately after begin() resolved", "poll until the reader sees the new value (settle time)", "after a full resume() every tab's inspect() is compared"], async (s) => {
    const trials = [];
    for (let i = 0; i < 30; i++) {
      const ctx = await browser.newContext(); const [w, r1, r2] = [await tab(ctx, "new"), await tab(ctx, "new"), await tab(ctx, "new")]; await seed(w);
      await w.evaluate(async () => { const c = cur.makeController(); const p = c.preflight(); window.__b = await c.begin(p.plan); });
      const expected = await w.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace"));
      const immediate = await r1.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace")); let settled = null; const t0 = Date.now();
      while (Date.now() - t0 < 3000) { if ((await r2.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace"))) === expected) { settled = Date.now() - t0; break; } await sleep(5); }
      await w.evaluate(async () => { await cur.makeController().resume(); });
      const modes = await Promise.all([w, r1, r2].map((p) => p.evaluate(() => cur.makeController().inspect().mode)));
      trials.push({ immediateStale: immediate !== expected, settledMs: settled, modes }); await ctx.close();
    }
    s.evidence = { trials: trials.length, immediateStaleReads: trials.filter((t) => t.immediateStale).length, maxSettleMs: Math.max(...trials.map((t) => t.settledMs ?? 99999)), unsettled: trials.filter((t) => t.settledMs === null).length };
    check(s, "every reader eventually sees the writer's marker (within 3 s)", s.evidence.unsettled === 0, s.evidence);
    check(s, "after resume() all three tabs report durable in every trial", trials.every((t) => t.modes.every((m) => m === "durable")), trials.filter((t) => !t.modes.every((m) => m === "durable")).slice(0, 2));
    s.notTested.push(`Informational (not asserted): ${s.evidence.immediateStaleReads}/30 immediate cross-tab reads were stale in this run.`);
  });

// ------------------------------------------------------------------ S2-12
await scenario("S2-12", "Pre-loaded OLD tab autosaves after each lifecycle phase (real old code, real Chromium)", "documents the gap: the old writer is NOT blocked at any phase; the controller detects the changed bytes",
  ["old tab loads (readProjectsLocked) BEFORE intent", "new tab drives the real controller to the phase", "old tab runs its real autosave: saveProjectsLocked(snapshot, undefined, baselineRaw)", "new tab inspect() and advance(); exportPreservedSource()"], async (s) => {
    const rows = [];
    for (const phase of PHASES) for (let i = 0; i < 5; i++) {
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a); const old = await tab(ctx, "old"); const loaded = await old.evaluate(() => leg.oldLoad());
      await a.evaluate((ph) => cur.driveTo(ph), phase); const markerBefore = await a.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace"));
      const w = await old.evaluate(async (ph) => { const r = await leg.oldAutosave("old-after-" + ph); return { ok: r.ok, reason: r.reason }; }, phase);
      const markerAfterOldWrite = await a.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace"));
      const r = await a.evaluate(async ([RAW, ph]) => {
        const c = cur.makeController(); const now = localStorage.getItem("devmate-workspace-v1"); const insp = c.inspect(); const adv = await c.advance();
        return { legacyChanged: now !== RAW, inspect: { mode: insp.mode, reason: insp.reason }, advance: { ok: adv.ok, reason: adv.reason, divergentPreserved: adv.divergentPreserved, changed: adv.changed }, markerPhaseAfter: cur.markerPhase(), originalCopyIntact: c.exportPreservedSource().raw === RAW, divergentCopyStored: Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length, currentWriter: cur.storage.saveProjects(JSON.parse(RAW), localStorage, now).reason };
      }, [RAW, phase]);
      rows.push({ phase, loadedStatus: loaded.status, oldWrite: w, markerBytesUnchangedByOldWrite: markerBefore === markerAfterOldWrite, ...r });
      await ctx.close();
    }
    const by = (p) => rows.filter((r) => r.phase === p);
    s.evidence = { trials: rows.length, perPhase: Object.fromEntries(PHASES.map((p) => [p, { oldWriteOk: by(p).filter((r) => r.oldWrite.ok).length + "/" + by(p).length, inspect: [...new Set(by(p).map((r) => r.inspect.mode + ":" + r.inspect.reason))], advance: [...new Set(by(p).map((r) => r.advance.reason ?? "ok"))] }])), sample: rows[0] };
    check(s, "GAP CONFIRMED: the old autosave succeeds in 20/20 trials, at every phase", rows.every((r) => r.oldWrite.ok), rows.filter((r) => !r.oldWrite.ok).slice(0, 3));
    check(s, "the new side detects it: inspect() indeterminate/source-changed and advance() refuses with source-changed", rows.every((r) => r.inspect.mode === "indeterminate" && r.inspect.reason === "source-changed" && r.advance.reason === "source-changed" && r.advance.ok === false), rows.filter((r) => !(r.inspect.reason === "source-changed")).slice(0, 3));
    check(s, "the old write does not touch the marker bytes at all", rows.every((r) => r.markerBytesUnchangedByOldWrite), rows.filter((r) => !r.markerBytesUnchangedByOldWrite).slice(0, 3));
    check(s, "the original bytes stay preserved and the divergent bytes are preserved too (2 copies); the marker never advances past its phase", rows.every((r) => r.originalCopyIntact && r.advance.divergentPreserved === true && r.divergentCopyStored === 2 && r.markerPhaseAfter === r.phase), rows.filter((r) => !(r.originalCopyIntact && r.divergentCopyStored === 2)).slice(0, 3));
    check(s, "contrast: the current writer is refused (cutover-active) in the same state", rows.every((r) => r.currentWriter === "cutover-active"), [...new Set(rows.map((r) => r.currentWriter))]);
  });

// ------------------------------------------------------------------ S2-13
await scenario("S2-13", "OLD deleteBackup / restoreBackup / load-with-backup after each phase (UI-shaped calls, real Chromium)", "documents which old mutators the controller can and cannot see",
  ["seed workspace + three legacy backup slots (+ .meta) as fixtures; old tab loaded before intent", "drive to the phase", "(i) old deleteBackup(key, undefined, fingerprint) for every listed backup", "(ii) old restoreBackup(key, undefined, fingerprint)", "(iii) an old bundle LOADING after intent on a workspace in 'recovered' shape (readProjectsLocked writes a backup)"], async (s) => {
    const META = (r) => JSON.stringify({ createdAt: 1700000000000, reason: r });
    const seedBackups = (p) => p.evaluate(([OTHER, META1, META2]) => { localStorage.setItem("devmate-workspace-v1.unreadable-backup", OTHER); localStorage.setItem("devmate-workspace-v1.unreadable-backup.meta", META1); localStorage.setItem("devmate-workspace-v1.unreadable-backup.2", JSON.stringify([{ id: "p8", name: "older-2", tasks: [] }])); localStorage.setItem("devmate-workspace-v1.unreadable-backup.2.meta", META2); localStorage.setItem("devmate-workspace-v1.unreadable-backup.3", JSON.stringify([{ id: "p7", name: "older-3", tasks: [] }])); }, [OTHER, META("corrupt"), META("recovered")]);
    const rows = [];
    for (const phase of PHASES) {
      { // (i) delete
        const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a); await seedBackups(a); const old = await tab(ctx, "old"); await old.evaluate(() => leg.oldLoad());
        await a.evaluate((ph) => cur.driveTo(ph), phase);
        const before = await a.evaluate(async () => { const c = cur.makeController(); return { mode: c.inspect().mode, abort: (await c.verifyAbortEligibility()).eligible }; });
        const currentDeleteWhileBackupsExist = await a.evaluate(async () => ({ reason: (await cur.storage.deleteBackup(cur.storage.BACKUP_KEY, localStorage)).reason, backupStillThere: localStorage.getItem("devmate-workspace-v1.unreadable-backup") !== null }));
        const del = await old.evaluate(() => leg.oldDeleteAllBackupsUiShaped());
        const writerView = await old.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("devmate-workspace-v1.unreadable-backup")).length);
        const seen = await settle(a, () => Object.keys(localStorage).filter((k) => k.startsWith("devmate-workspace-v1.unreadable-backup")).length, (n) => n === 0);
        const after = await a.evaluate(async (RAW) => { const c = cur.makeController(); return { mode: c.inspect().mode, reason: c.inspect().reason ?? null, abort: (await c.verifyAbortEligibility()).eligible, legacyUnchanged: localStorage.getItem("devmate-workspace-v1") === RAW }; }, RAW);
        rows.push({ kind: "delete", phase, deletedOk: del.filter((d) => d.result.ok).length, listed: del.length, currentDeleteWhileBackupsExist, before, backupKeysLeftInWriterTab: writerView, otherTabSawDeletionImmediately: seen.immediateAlreadyTrue, otherTabSettledMs: seen.settledMs, after }); await ctx.close();
      }
      { // (ii) restore
        const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a); await seedBackups(a); const old = await tab(ctx, "old"); await old.evaluate(() => leg.oldLoad());
        await a.evaluate((ph) => cur.driveTo(ph), phase); const keysBefore = keysOf(await dump(old));
        const res = await old.evaluate(() => leg.oldRestoreFirstBackupUiShaped());
        const keysAfter = keysOf(await dump(old));
        const seen2 = await settle(a, (RAW) => localStorage.getItem("devmate-workspace-v1") !== RAW, (changed) => changed === true, RAW);
        const after = await a.evaluate(async (RAW) => { const c = cur.makeController(); const i = c.inspect(); return { mode: i.mode, reason: i.reason ?? null, legacyChanged: localStorage.getItem("devmate-workspace-v1") !== RAW, copies: Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1:source:")).length }; }, RAW);
        rows.push({ kind: "restore", phase, ok: res?.result?.ok, newBackupKeysCreatedByOldRestore: keysAfter.filter((k) => !keysBefore.includes(k) && k.includes("unreadable-backup")).length, otherTabSawNewBytesImmediately: seen2.immediateAlreadyTrue, otherTabSettledMs: seen2.settledMs, after }); await ctx.close();
      }
      { // (iii) old bundle loads after intent on a recovered-shape workspace
        const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a, RECOVERED);
        await a.evaluate((ph) => cur.driveTo(ph), phase); const markerBefore = await a.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace"));
        const old = await tab(ctx, "old"); const keysBefore = keysOf(await dump(old)); const loaded = await old.evaluate(() => leg.oldLoad()); const keysAfter = keysOf(await dump(old));
        const seen = await settle(a, () => Object.keys(localStorage).some((k) => k.includes("unreadable-backup")), (v) => v === true);
        const after = await a.evaluate(async (RECOVERED) => { const c = cur.makeController(); const i = c.inspect(); return { mode: i.mode, legacyUnchanged: localStorage.getItem("devmate-workspace-v1") === RECOVERED, markerUnchanged: localStorage.getItem("devmate-cutover-v1:workspace") !== null }; }, RECOVERED);
        rows.push({ kind: "load-backup", phase, status: loaded.status, backedUp: loaded.backedUp, newKeys: keysAfter.filter((k) => !keysBefore.includes(k)), markerBytesUnchanged: markerBefore === (await a.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace"))), otherTabSettledMs: seen.settledMs, after }); await ctx.close();
      }
    }
    s.evidence = { rows };
    const exp = { intent: "recovery", "profiles-verified": "recovery", "stores-verified": "recovery", committed: "durable" };
    const del = rows.filter((r) => r.kind === "delete"), rst = rows.filter((r) => r.kind === "restore"), ld = rows.filter((r) => r.kind === "load-backup");
    check(s, "(i) GAP CONFIRMED: old deleteBackup (UI-shaped, with fingerprint) deleted all 3 backups at every phase", del.every((r) => r.deletedOk === 3 && r.listed === 3 && r.backupKeysLeftInWriterTab === 0), del);
    check(s, "(i) the controller does NOT detect it: inspect() unchanged, legacy bytes unchanged, abort-eligibility verdict unchanged", del.every((r) => r.after.mode === exp[r.phase] && r.after.legacyUnchanged && r.after.abort === r.before.abort), del.map((r) => [r.phase, r.before, r.after.mode, r.after.abort]));
    check(s, "(i) contrast, measured BEFORE the old delete: the CURRENT deleteBackup refuses (cutover-active) and the backup is still there", del.every((r) => r.currentDeleteWhileBackupsExist.reason === "cutover-active" && r.currentDeleteWhileBackupsExist.backupStillThere), del.map((r) => [r.phase, r.currentDeleteWhileBackupsExist]));
    check(s, "(ii) old restoreBackup succeeds at every phase, changes the legacy bytes, creates a pre-restore snapshot slot, and is detected (source-changed)", rst.every((r) => r.ok === true && r.after.legacyChanged && r.newBackupKeysCreatedByOldRestore >= 1 && r.after.mode === "indeterminate" && r.after.reason === "source-changed"), rst);
    check(s, "(iii) an old bundle loading after intent WRITES a new backup slot (workspace untouched, marker untouched) and the controller does not see it", ld.every((r) => r.status === "recovered" && r.backedUp === true && r.newKeys.some((k) => k.includes("unreadable-backup")) && r.markerBytesUnchanged && r.after.legacyUnchanged && r.after.mode === exp[r.phase]), ld);
  });

// ------------------------------------------------------------------ S2-14
await scenario("S2-14", "OLD tab waits behind the controller's real lock, then writes after release / times out / is closed", "serialization only: the old write lands after release; it is refused only by the 8 s timeout; closing the waiter drops the write",
  ["new tab runs advance() with a stage gated open (holds the real lock)", "old tab starts its real autosave -> pending request", "variant A: release the gate before 8 s", "variant B: keep holding for > 8 s", "variant C: close the waiting old tab, then release"], async (s) => {
    const gatedAdvance = (a) => a.evaluate(async () => { const real = cur.createCutoverStages(); window.__open = null; window.__gate = new Promise((r) => { window.__open = r; }); const stages = { ...real, migrateProfiles: async () => { const r = await real.migrateProfiles(); await window.__gate; return r; } }; window.__adv = cur.makeController({ stages }).advance(); });
    const setup = async () => { const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a); const old = await tab(ctx, "old"); await old.evaluate(() => leg.oldLoad()); await a.evaluate(() => cur.driveTo("intent")); await gatedAdvance(a); await sleep(200); return { ctx, a, old }; };
    const queue = (old) => old.evaluate(() => { window.__t0 = performance.now(); window.__old = leg.oldAutosave("old-queued-behind-lock").then((r) => ({ ok: r.ok, reason: r.reason, waitedMs: Math.round(performance.now() - window.__t0) })); });
    const locks = (p) => p.evaluate(async () => { const q = await navigator.locks.query(); return { held: q.held.length, pending: q.pending.length }; });
    { const { ctx, a, old } = await setup(); await queue(old); await sleep(500);
      const during = await locks(a); const unresolved = await old.evaluate(() => Promise.race([window.__old.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 200))])); const legacyDuring = (await dump(a))[LEGACY] === RAW;
      await a.evaluate(() => window.__open()); const adv = await a.evaluate(async () => { const r = await window.__adv; return { ok: r.ok, changed: r.changed }; }); const oldRes = await old.evaluate(() => window.__old);
      const after = await a.evaluate(async () => { const c = cur.makeController(); const i = c.inspect(); const x = await c.advance(); return { mode: i.mode, reason: i.reason, advance: x.reason, divergentPreserved: x.divergentPreserved, phase: cur.markerPhase() }; });
      s.evidence.A_releasedBeforeTimeout = { during, unresolved, legacyUnchangedWhileWaiting: legacyDuring, advance: adv, oldWrite: oldRes, after };
      check(s, "A: while the controller holds the lock the old write is pending (1 held, >=1 pending) and the workspace is unchanged", during.held === 1 && during.pending >= 1 && unresolved === "pending" && legacyDuring, s.evidence.A_releasedBeforeTimeout);
      check(s, "A: the controller's advance finishes first (profiles-verified), THEN the old write succeeds", adv.ok && oldRes.ok === true && after.phase === "profiles-verified", s.evidence.A_releasedBeforeTimeout);
      check(s, "A: afterwards the controller detects it (indeterminate/source-changed, next advance refused, divergent bytes preserved)", after.mode === "indeterminate" && after.reason === "source-changed" && after.advance === "source-changed" && after.divergentPreserved === true, after);
      await ctx.close(); }
    { const { ctx, a, old } = await setup(); await queue(old); const oldRes = await old.evaluate(() => window.__old); const unchanged = (await dump(a))[LEGACY] === RAW;
      await a.evaluate(() => window.__open()); const adv = await a.evaluate(async () => { const r = await window.__adv; return { ok: r.ok }; }); const mode = await a.evaluate(() => cur.makeController().inspect().mode);
      s.evidence.B_heldBeyondTimeout = { oldWrite: oldRes, legacyUnchanged: unchanged, advance: adv, modeAfter: mode };
      check(s, "B: held > 8 s -> the old write fails with lock-timeout after ~8 s, workspace unchanged, controller still recovery (nothing divergent)", oldRes.ok === false && oldRes.reason === "lock-timeout" && oldRes.waitedMs > 7500 && oldRes.waitedMs < 9500 && unchanged && mode === "recovery", s.evidence.B_heldBeyondTimeout);
      await ctx.close(); }
    { const { ctx, a, old } = await setup(); await queue(old); await sleep(400); const pendingBefore = await locks(a);
      await old.close({ runBeforeUnload: false }); await sleep(300); const pendingAfterClose = await locks(a);
      await a.evaluate(() => window.__open()); await a.evaluate(() => window.__adv); await sleep(300);
      const d = await dump(a); const mode = await a.evaluate(() => cur.makeController().inspect().mode);
      s.evidence.C_waiterClosed = { pendingBefore, pendingAfterClose, legacyUnchanged: d[LEGACY] === RAW, modeAfter: mode, phase: phaseOf(d[MARKER]) };
      check(s, "C: closing the waiting old tab removes its pending lock request and the queued write never happens", pendingBefore.pending >= 1 && pendingAfterClose.pending === 0 && d[LEGACY] === RAW && mode === "recovery", s.evidence.C_waiterClosed);
      await ctx.close(); }
  });

// ------------------------------------------------------------------ S2-16
await scenario("S2-16", "Real saveProjectsLocked from two real tabs with expectedRaw: are app updates ever silently overwritten?", "with expectedRaw, two tabs never both succeed from the same baseline, and every update a tab was told succeeded is present in the final workspace",
  ["(A) 40 trials: fresh context, seed, two tabs each load the baseline with the real readProjectsLocked, then both call the real saveProjectsLocked(projects, undefined, baseline) at the same instant with different edits", "(B) 2 tabs x 25 edits each: each edit = real readProjectsLocked, append one uniquely titled task, real saveProjectsLocked(..., loadedRaw); on conflict reload and retry. After both finish compare every acknowledged edit against the final stored workspace", "(C) one tab saves, then the second tab (same baseline) saves after the first save returned and a settle wait"], async (s) => {
    const mkProjects = `(raw, title) => { const ps = JSON.parse(raw); ps[0].tasks.push({ id: title, title, done: false, createdAt: Date.now() }); return ps; }`;
    // (A) simultaneous, same baseline
    const A = [];
    for (let t = 0; t < 40; t++) {
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"), b = await tab(ctx, "new"); await seed(a); await sleep(150);
      const load = (p) => p.evaluate(async () => { const r = await cur.storage.readProjectsLocked(); window.__base = r.storageRaw; return r.storageRaw === localStorage.getItem("devmate-workspace-v1"); });
      const baseOk = [await load(a), await load(b)];
      const go = (p, title) => p.evaluate(async ({ title, mk }) => { const ps = eval(mk)(window.__base, title); const r = await cur.storage.saveProjectsLocked(ps, undefined, window.__base); return { ok: r.ok, reason: r.ok ? null : r.reason }; }, { title, mk: mkProjects });
      const [ra, rb] = await Promise.all([go(a, `A-${t}-a`), go(b, `A-${t}-b`)]);
      await sleep(300);
      const final = await a.evaluate(() => localStorage.getItem("devmate-workspace-v1")); const titles = JSON.parse(final)[0].tasks.map((x) => x.title).filter((x) => x.startsWith("A-"));
      A.push({ t, baseOk, ra, rb, finalTitles: titles });
      await ctx.close();
    }
    const bothOk = A.filter((r) => r.ra.ok && r.rb.ok), oneOk = A.filter((r) => r.ra.ok !== r.rb.ok), noneOk = A.filter((r) => !r.ra.ok && !r.rb.ok);
    const silentLossA = A.filter((r) => (r.ra.ok && !r.finalTitles.includes(`A-${r.t}-a`)) || (r.rb.ok && !r.finalTitles.includes(`A-${r.t}-b`)));
    s.evidence.A_simultaneousSameBaseline = { trials: A.length, exactlyOneSucceeded: oneOk.length, bothSucceeded: bothOk.length, noneSucceeded: noneOk.length, conflictReasons: [...new Set(A.flatMap((r) => [r.ra, r.rb]).filter((x) => !x.ok).map((x) => x.reason))], acknowledgedButMissingInFinal: silentLossA.length, staleBaselineTrials: A.filter((r) => r.baseOk.includes(false)).length, sampleBothSucceeded: bothOk.slice(0, 3) };
    check(s, "(A) never both tabs acknowledged from the same baseline (no silent overwrite)", bothOk.length === 0, s.evidence.A_simultaneousSameBaseline);
    check(s, "(A) every acknowledged update is present in the final workspace", silentLossA.length === 0, silentLossA.slice(0, 3));
    // (B) sustained alternating edits
    {
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"), b = await tab(ctx, "new"); await seed(a); await sleep(150);
      const work = (p, who) => p.evaluate(async ({ who, mk }) => {
        const acked = []; let conflicts = 0, other = 0;
        for (let i = 0; i < 25; i++) {
          for (let attempt = 0; attempt < 50; attempt++) {
            const r = await cur.storage.readProjectsLocked(); const title = `B-${who}-${i}`;
            const ps = eval(mk)(r.storageRaw, title);
            const w = await cur.storage.saveProjectsLocked(ps, undefined, r.storageRaw);
            if (w.ok) { acked.push(title); break; }
            if (w.reason === "conflict") { conflicts++; await new Promise((x) => setTimeout(x, 2)); continue; }
            other++; break;
          }
        }
        return { acked, conflicts, other };
      }, { who, mk: mkProjects });
      const [ra, rb] = await Promise.all([work(a, "a"), work(b, "b")]); await sleep(500);
      const final = await a.evaluate(() => localStorage.getItem("devmate-workspace-v1")); const have = new Set(JSON.parse(final)[0].tasks.map((x) => x.title));
      const acked = [...ra.acked, ...rb.acked]; const missing = acked.filter((t) => !have.has(t));
      s.evidence.B_sustainedTwoTabs = { editsAttemptedPerTab: 25, acknowledged: acked.length, conflictsReported: ra.conflicts + rb.conflicts, otherFailures: ra.other + rb.other, presentInFinal: [...have].filter((t) => t.startsWith("B-")).length, acknowledgedButMissing: missing.length, missingTitles: missing.slice(0, 10) };
      check(s, "(B) every update acknowledged as saved is present in the final workspace (none silently overwritten)", missing.length === 0 && ra.other + rb.other === 0, s.evidence.B_sustainedTwoTabs);
      await ctx.close();
    }
    // (C) strictly sequential, same baseline
    {
      const ctx = await browser.newContext(); const a = await tab(ctx, "new"), b = await tab(ctx, "new"); await seed(a); await sleep(150);
      const base = [await a.evaluate(async () => (window.__base = (await cur.storage.readProjectsLocked()).storageRaw)), await b.evaluate(async () => (window.__base = (await cur.storage.readProjectsLocked()).storageRaw))];
      const go = (p, title) => p.evaluate(async ({ title, mk }) => { const r = await cur.storage.saveProjectsLocked(eval(mk)(window.__base, title), undefined, window.__base); return { ok: r.ok, reason: r.ok ? null : r.reason }; }, { title, mk: mkProjects });
      const first = await go(a, "C-first"); await sleep(1500); const second = await go(b, "C-second");
      const final = JSON.parse(await a.evaluate(() => localStorage.getItem("devmate-workspace-v1")))[0].tasks.map((x) => x.title);
      s.evidence.C_sequentialSameBaseline = { sameBaseline: base[0] === base[1], first, second, finalTitles: final.filter((t) => t.startsWith("C-")) };
      check(s, "(C) the second tab, using the now-outdated baseline 1.5 s after the first save, gets conflict and does not overwrite", first.ok && !second.ok && second.reason === "conflict" && final.includes("C-first") && !final.includes("C-second"), s.evidence.C_sequentialSameBaseline);
      await ctx.close();
    }
    s.notTested.push("Edits are produced by a minimal helper that appends one task (the real App/React UI was not run); the production functions readProjectsLocked and saveProjectsLocked are the real ones from src/storage.ts at PR #33 head.", "Only two tabs of one browser profile; no more than 25 edits per tab; timing is host-specific.");
  });

// ------------------------------------------------------------------ S2-15
await scenario("S2-15", "Back/forward cache (BFCache) probe for a stale old tab", "if the old tab is restored from BFCache, record that it can still write; otherwise record that BFCache was not exercised",
  ["old tab loads and baselines, navigates to another same-origin page, goBack()", "read pageshow.persisted", "if persisted: drive the real controller to intent in another tab, then run the restored tab's autosave"], async (s) => {
    const ctx = await browser.newContext(); const a = await tab(ctx, "new"); await seed(a); const old = await ctx.newPage();
    await old.addInitScript(() => { window.addEventListener("pageshow", (e) => { (window.__ps = window.__ps ?? []).push(e.persisted); }); });
    await old.goto(`${origin}/old.html`); await old.evaluate(() => { window.__marker = "kept-in-memory"; return leg.oldLoad(); });
    await old.goto(`${origin}/p2.html`); await old.goBack(); await sleep(500);
    const probe = await old.evaluate(() => ({ marker: window.__marker ?? null, pageshow: window.__ps ?? null, baselineKept: typeof window.__baseline === "string" }));
    s.evidence.probe = probe;
    if (probe.marker === "kept-in-memory") {
      await a.evaluate(() => cur.driveTo("intent")); const w = await old.evaluate(async () => { const r = await leg.oldAutosave("old-restored-from-bfcache"); return { ok: r.ok, reason: r.reason }; });
      const mode = await a.evaluate(() => ({ ...cur.makeController().inspect() }));
      s.evidence.restoredTabWrite = { write: w, controller: { mode: mode.mode, reason: mode.reason } };
      check(s, "BFCache restoration happened (window state survived goBack) -- the restored old tab's autosave still succeeds and is only detected afterwards", w.ok === true && mode.mode === "indeterminate", s.evidence.restoredTabWrite);
    } else {
      s.forceStatus = "NOT TESTED";
      s.notTested.push("BFCache was NOT exercised: after goBack() the page was reloaded (in-memory marker lost, pageshow persisted=false), so a BFCache-restored stale tab could not be tested in this headless Chromium. This scenario proves nothing about BFCache and must not be counted as a pass.");
      s.evidence.reason = "goBack() did not restore the page from the back/forward cache in this build";
    }
    await ctx.close();
  });

await browser.close(); server.close();
results.meta.finishedAt = new Date().toISOString();
results.summary = { scenarios: results.scenarios.length, pass: results.scenarios.filter((s) => s.status === "PASS").length, fail: results.scenarios.filter((s) => s.status === "FAIL").length, error: results.scenarios.filter((s) => s.status === "ERROR").length, notTested: results.scenarios.filter((s) => s.status === "NOT TESTED").length, checks: results.scenarios.reduce((n, s) => n + s.checks.length, 0), checksPassed: results.scenarios.reduce((n, s) => n + s.checks.filter((c) => c.pass).length, 0) };
const target = outArg ? `${here}${outArg}` : only.length ? `${out}results.partial.json` : `${here}results.json`;
writeFileSync(target, JSON.stringify(results, null, 2) + "\n");
console.log("\n" + JSON.stringify(results.summary), "->", target);
process.exit(results.summary.fail || results.summary.error ? 1 : 0);
