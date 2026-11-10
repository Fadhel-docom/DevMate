// Real-Chromium evidence for PR-D (R1 narrowing, R6 matrix, S3 archive in the built app).
// Not part of `npm test` and not run by GitHub Actions. Usage (from repo root, after `npm ci`):
//   cd e2e/r6-matrix && npm ci && npx playwright install chromium && cd ../.. && node e2e/r6-matrix/run.mjs
// Writes e2e/r6-matrix/results.json. Exit code 1 if any check fails.
import { chromium } from "playwright";
import http from "node:http";
import os from "node:os";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const here = new URL(".", import.meta.url).pathname, root = new URL("../../", import.meta.url).pathname, out = here + "out/";
mkdirSync(out, { recursive: true });
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] }).toString();
const git = (...a) => { try { return sh("git", a).trim(); } catch { return null; } };

// 1. Build the real production bundle and the harness bundles from the working tree.
sh("npm", ["run", "build"]);
const esbuild = root + "node_modules/esbuild/bin/esbuild";
for (const [entry, name] of [["entry-ctl.ts", "ctl"], ["entry-legacy.ts", "legacy"]])
  execFileSync(esbuild, [here + entry, "--bundle", "--format=iife", `--global-name=${name}`, `--outfile=${out}${name}.js`, "--log-level=error"]);
const dist = root + "dist/";
const distAssets = readdirSync(dist + "assets").filter((f) => f.endsWith(".js")).map((f) => readFileSync(dist + "assets/" + f, "utf8"));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  const send = (body, type) => { res.setHeader("content-type", type); res.end(body); };
  if (u === "/__h.html") return send(readFileSync(here + "harness.html"), "text/html");
  if (u === "/__ctl.js") return send(readFileSync(out + "ctl.js"), "text/javascript");
  if (u === "/__legacy.js") return send(readFileSync(out + "legacy.js"), "text/javascript");
  const file = u === "/" ? "index.html" : u.slice(1);
  if (file.includes("..") || !existsSync(dist + file)) { res.statusCode = 404; return res.end(); }
  send(readFileSync(dist + file), MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = {
  generatedAt: new Date().toISOString(), command: "node e2e/r6-matrix/run.mjs",
  environment: { chromium: browser.version(), playwright: createRequire(import.meta.url)("playwright/package.json").version, node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, headless: true, origin: "http://localhost:<ephemeral>" },
  sourceCommit: git("rev-parse", "HEAD"), workingTreeDirty: (git("status", "--porcelain") ?? "").length > 0, cases: []
};
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function Case(id, title, extra = {}) { const c = { id, title, ...extra, checks: [] }; results.cases.push(c); return c; }
function ck(c, name, pass, detail) { c.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); if (!pass) { failures++; console.error(`FAIL [${c.id}] ${name}`, detail ?? ""); } }

const RAW = JSON.stringify([
  { id: "proj-a", name: "Alpha é€😀", tasks: [{ id: "a1", title: "Alpha one", done: false, createdAt: 1 }, { id: "a2", title: "Alpha two", done: true, createdAt: 2 }] },
  { id: "proj-b", name: "Bravo", tasks: [{ id: "b1", title: "Bravo one", done: false, createdAt: 3 }] },
  { id: "proj-c", name: "Charlie", tasks: [] }
]);
const IDS = ["proj-a", "proj-b", "proj-c"];
const PHASES = ["intent", "profiles-verified", "stores-verified", "committed"];
const MARKER = "devmate-cutover-v1:workspace";

async function harness(ctx, { init } = {}) { const p = await ctx.newPage(); if (init) await p.addInitScript(init); await p.goto(origin + "/__h.html"); return p; }
const seed = (p, raw = RAW) => p.evaluate((raw) => { localStorage.clear(); if (raw !== null) localStorage.setItem("devmate-workspace-v1", raw); }, raw);
const dump = (p) => p.evaluate(() => window.dump());
const profileStatus = (p) => p.evaluate(async () => {
  const out = {}; const c = ctl.createCutoverStages({ storage: localStorage });
  out.migrationVerified = (await c.verifyProfiles()).ok; out.storesVerified = (await c.verifyStores()).ok; return out;
});
async function ctxWith(opts = {}) { return browser.newContext(opts); }

// ---------------------------------------------------------------- C1
{
  const c = Case("C1", "Production bundle cannot start a cutover (R1 narrowing); legacy mode still works in the built app");
  const joined = distAssets.join("\n");
  for (const needle of ["legacy-writers-not-quiesced", "confirmLegacyWritersQuiesced", "preserve-quota", "stage-failed", "createCutoverStages"])
    ck(c, `built bundle does not contain "${needle}"`, !joined.includes(needle));
  ck(c, "built bundle contains the read-only marker key (barrier/inspector present)", joined.includes(MARKER));
  ck(c, "built bundle contains no marker writer: no setItem call is adjacent to the marker key", !/setItem\([^)]{0,40}devmate-cutover-v1/.test(joined));
  const ctx = await ctxWith(); const h = await harness(ctx); await seed(h); await h.close();
  const app = await ctx.newPage(); await app.goto(origin + "/");
  await app.waitForSelector('input[aria-label="New project name"]');
  ck(c, "legacy mode: project input is enabled", await app.locator('input[aria-label="New project name"]').isEnabled());
  ck(c, "legacy mode: no recovery panel and no cutover banner", (await app.locator('[data-testid="recovery-archive"], [data-testid="cutover-banner"]').count()) === 0);
  const controls = await app.locator("button, a, input, select").evaluateAll((els) => els.map((e) => (e.textContent || e.getAttribute("aria-label") || "").toLowerCase()));
  ck(c, "no UI control mentions cutover, migrate or commit", !controls.some((t) => /cutover|migrat|commit/.test(t)), controls);
  ck(c, "page exposes no cutover globals", await app.evaluate(() => !("ctl" in window) && !("legacy" in window) && !("mk" in window)));
  await app.locator('input[aria-label="New project name"]').fill("Added in built app"); await app.keyboard.press("Enter");
  await app.waitForFunction(() => (localStorage.getItem("devmate-workspace-v1") || "").includes("Added in built app"));
  ck(c, "legacy editing in the built app still saves to localStorage", true);
  await ctx.close();
}

// ---------------------------------------------------------------- C2
for (const phase of PHASES) {
  const c = Case("C2-" + phase, `Built app in real Chromium at cutover phase "${phase}": truthful state, locked editing, read-only task list, byte-exact raw export, reload keeps state`);
  const ctx = await ctxWith({ acceptDownloads: true, viewport: { width: 360, height: 740 } });
  const h = await harness(ctx); await seed(h); const lc = await h.evaluate((to) => lifecycle(to), phase); ck(c, "harness reached the phase", lc.ok, lc);
  const before = await dump(h); await h.close();
  const app = await ctx.newPage();
  for (const round of ["first load", "after reload"]) {
    if (round === "first load") await app.goto(origin + "/"); else await app.reload();
    await app.waitForSelector('[data-testid="recovery-archive"]');
    const text = await app.locator('[data-testid="recovery-archive"]').innerText();
    ck(c, `${round}: panel describes the phase truthfully`, phase === "committed" ? /no durable workspace screen/.test(text) : text.includes(`phase "${phase}"`), text.slice(0, 200));
    ck(c, `${round}: editing is disabled`, !(await app.locator('input[aria-label="New project name"]').isEnabled()) && !(await app.locator('input[aria-label="New task"]').isEnabled()));
    ck(c, `${round}: legacy tasks are listed read-only (3 tasks)`, (await app.locator('[data-testid="archive-source-preserved"]').innerText()).includes("3 tasks"));
    ck(c, `${round}: panel has no input, form or destructive control`, (await app.locator('[data-testid="recovery-archive"] input, [data-testid="recovery-archive"] form').count()) === 0 && !/\b(Restore|Delete|Release|Prune|Resume)\b/.test(text));
    const btn = app.getByRole("button", { name: /Download raw data \(preserved legacy copy\)/ });
    await btn.focus(); const [dl] = await Promise.all([app.waitForEvent("download"), app.keyboard.press("Enter")]);   // keyboard operable
    const bytes = readFileSync(await dl.path());
    ck(c, `${round}: downloaded file bytes equal the stored legacy bytes (UTF-8, ${Buffer.byteLength(RAW)} bytes)`, bytes.equals(Buffer.from(RAW, "utf8")), { got: bytes.length, filename: dl.suggestedFilename() });
    ck(c, `${round}: status region announces the download (role=status)`, (await app.getByRole("status").filter({ hasText: "Download requested" }).count()) === 1);
    ck(c, `${round}: panel is a labelled region`, (await app.getByRole("region", { name: /./ }).count()) >= 1);
    const m = await app.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    ck(c, `${round}: mobile 360px layout has no horizontal overflow`, m.sw <= m.iw, m);
    const after = await app.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
    ck(c, `${round}: loading the app and exporting wrote nothing to storage`, after === before);
  }
  await ctx.close();
}

// ---------------------------------------------------------------- C3
{
  const c = Case("C3", "Divergence and unreadable-state truthfulness in the built app (old writer, malformed marker, unreadable marker)");
  for (const target of ["intent", "committed"]) {
    const ctx = await ctxWith({ acceptDownloads: true });
    const oldTab = await ctx.newPage(); await oldTab.goto(origin + "/__h.html");           // loaded BEFORE the marker exists
    const newTab = await harness(ctx); await seed(newTab); await newTab.evaluate((to) => lifecycle(to), target);
    const w = await oldTab.evaluate(async () => legacy.saveProjectsLocked([{ id: "proj-a", name: "EDITED BY OLD TAB", tasks: [] }], undefined, localStorage.getItem("devmate-workspace-v1")));
    ck(c, `LIMITATION (not a fix): the unmodified pre-barrier writer still succeeds after "${target}"`, w.ok === true, { ok: w.ok });
    const diverged = await newTab.evaluate(() => localStorage.getItem("devmate-workspace-v1"));
    const app = await ctx.newPage(); await app.goto(origin + "/"); await app.waitForSelector('[data-testid="recovery-archive"]');
    ck(c, `after old-writer divergence at "${target}": app reports an alert, editing locked`, (await app.locator('[data-testid="cutover-banner"]').getAttribute("role")) === "alert" && !(await app.locator('input[aria-label="New project name"]').isEnabled()));
    ck(c, `after divergence at "${target}": both sources are offered`, (await app.locator('[data-testid="archive-source-preserved"]').count()) === 1 && (await app.locator('[data-testid="archive-source-current"]').count()) === 1);
    const grab = async (re) => { const [dl] = await Promise.all([app.waitForEvent("download"), app.getByRole("button", { name: re }).click()]); return readFileSync(await dl.path()); };
    ck(c, `divergence at "${target}": preserved export equals the original bytes`, (await grab(/Download raw data \(preserved legacy copy\)/)).equals(Buffer.from(RAW)));
    ck(c, `divergence at "${target}": current export equals the diverged bytes`, (await grab(/Download raw data \(current legacy workspace\)/)).equals(Buffer.from(diverged)));
    await ctx.close();
  }
  { const ctx = await ctxWith(); const h = await harness(ctx); await seed(h); await h.evaluate(() => localStorage.setItem("devmate-cutover-v1:workspace", "{broken")); const before = await dump(h); await h.close();
    const app = await ctx.newPage(); await app.goto(origin + "/"); await app.waitForSelector('[data-testid="recovery-archive"]');
    ck(c, "malformed marker: alert, editing locked, still exports legacy bytes", (await app.locator('[data-testid="cutover-banner"]').getAttribute("role")) === "alert" && !(await app.locator('input[aria-label="New project name"]').isEnabled()) && (await app.getByRole("button", { name: /Download raw data/ }).count()) >= 1);
    ck(c, "malformed marker: nothing written", (await app.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])))) === before);
    await ctx.close(); }
  { const ctx = await ctxWith();
    const h = await harness(ctx); await seed(h); await h.evaluate(() => localStorage.setItem("devmate-cutover-v1:workspace", "x")); await h.close();
    await ctx.addInitScript(() => { window.__writes = []; const g = Storage.prototype.getItem, s = Storage.prototype.setItem;
      Storage.prototype.getItem = function (k) { if (k === "devmate-cutover-v1:workspace") throw new DOMException("injected read failure", "SecurityError"); return g.call(this, k); };
      Storage.prototype.setItem = function (k, v) { window.__writes.push(k); return s.call(this, k, v); }; });
    const app = await ctx.newPage(); await app.goto(origin + "/"); await app.waitForSelector('[data-testid="cutover-banner"]');
    ck(c, "FAULT-INJECTED marker read failure: alert + editing locked", (await app.locator('[data-testid="cutover-banner"]').getAttribute("role")) === "alert" && !(await app.locator('input[aria-label="New project name"]').isEnabled()));
    ck(c, "FAULT-INJECTED marker read failure: the app performed no storage write", (await app.evaluate(() => window.__writes)).length === 0, await app.evaluate(() => window.__writes));
    await ctx.close(); }
}

// ---------------------------------------------------------------- C4
{
  const c = Case("C4", "Two real tabs, real Web Locks: contention and ordering (10 trials)");
  const ctx = await ctxWith(); const trials = [];
  const instr = () => { window.__log = []; const s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === "devmate-cutover-v1:workspace") { let ph = null; try { ph = JSON.parse(v).phase; } catch {} window.__log.push({ t: performance.timeOrigin + performance.now(), phase: ph }); } return s.call(this, k, v); }; };
  for (let i = 0; i < 10; i++) {
    const a = await harness(ctx, { init: instr }), b = await harness(ctx, { init: instr }); await seed(a);
    const begins = await Promise.all([a, b].map((p) => p.evaluate(async () => { const x = mk(); const plan = x.preflight(); if (!plan.ok) return { ok: false, reason: plan.reason }; const r = await x.begin(plan.plan); return { ok: r.ok, changed: r.ok ? r.changed : null, reason: r.ok ? null : r.reason }; })));
    const resumes = await Promise.all([a, b, a].map((p) => p.evaluate(async () => { const r = await mk().resume(); return { ok: r.ok, changed: r.ok ? r.changed : null, reason: r.ok ? null : r.reason }; })));
    const logs = [...(await a.evaluate(() => window.__log)), ...(await b.evaluate(() => window.__log))].sort((x, y) => x.t - y.t).map((e) => e.phase);
    const final = await a.evaluate(() => mode()); const stores = await profileStatus(a);
    trials.push({ begins, resumes, markerWriteOrder: logs, final, stores });
    await a.close(); await b.close();
  }
  ck(c, "every trial: exactly one tab declares intent; the other is a no-op or is refused with marker-present (never a second marker)", trials.every((t) => t.begins.filter((r) => r.ok && r.changed).length === 1 && t.begins.every((r) => r.ok || r.reason === "marker-present")), trials.map((t) => t.begins));
  ck(c, "every trial: all resume() calls ok", trials.every((t) => t.resumes.every((r) => r.ok)));
  ck(c, "every trial: marker writes happened exactly once per phase, in order", trials.every((t) => JSON.stringify(t.markerWriteOrder) === JSON.stringify(PHASES)), trials.map((t) => t.markerWriteOrder));
  ck(c, "every trial: final mode durable with verified profiles and stores", trials.every((t) => t.final === "durable" && t.stores.migrationVerified && t.stores.storesVerified));
  c.trials = trials; await ctx.close();
}

// ---------------------------------------------------------------- C5
{
  const c = Case("C5", "Real browser quota exhaustion (QuotaExceededError from Chromium, not simulated)");
  const fill = (p) => p.evaluate(() => { const names = []; let chunk = 1 << 20, i = 0;
    while (chunk >= 1) { try { const k = "filler:" + i++; localStorage.setItem(k, "x".repeat(chunk)); names.push(k); } catch (e) { if (e.name !== "QuotaExceededError") throw e; chunk >>= 1; } }
    return names; });
  const free = (p, names) => p.evaluate((names) => names.forEach((k) => localStorage.removeItem(k)), names);
  { const ctx = await ctxWith(); const h = await harness(ctx); await seed(h); const names = await fill(h);
    const quota = await h.evaluate(() => { try { localStorage.setItem("probe", "xx"); return null; } catch (e) { return e.name; } });
    ck(c, "storage is genuinely full (browser throws QuotaExceededError)", quota === "QuotaExceededError", quota);
    const r = await h.evaluate(() => lifecycle("intent")); const state = await h.evaluate(() => ({ marker: localStorage.getItem("devmate-cutover-v1:workspace"), legacy: localStorage.getItem("devmate-workspace-v1") }));
    ck(c, "begin fails closed with a quota-class reason", !r.ok && ["preserve-quota", "marker-write-failed"].includes(r.reason), r);
    ck(c, "no marker was written and legacy bytes are untouched", state.marker === null && state.legacy === RAW);
    await free(h, names); const retry = await h.evaluate(() => lifecycle("committed")); ck(c, "after freeing space the same lifecycle completes", retry.ok && retry.state === "durable", retry);
    ck(c, "legacy bytes still exact after recovery", (await h.evaluate(() => localStorage.getItem("devmate-workspace-v1"))) === RAW);
    await ctx.close(); }
  { const ctx = await ctxWith(); const h = await harness(ctx); await seed(h);
    const began = await h.evaluate(async () => { const x = mk(); const p = x.preflight(); return (await x.begin(p.plan)).ok; }); ck(c, "intent declared", began);
    const names = await fill(h); const r = await h.evaluate(async () => { const x = mk(); const a = await x.resume(); return { ok: a.ok, reason: a.ok ? null : a.reason, stage: a.ok ? null : a.stageReason ?? null, mode: mode() }; });
    ck(c, "migration under quota fails closed: stage-failed, still recovery, not durable", !r.ok && r.reason === "stage-failed" && r.mode === "recovery", r);
    ck(c, "legacy and preserved copy untouched under quota", (await h.evaluate(() => [localStorage.getItem("devmate-workspace-v1"), Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1:source:")).map((k) => localStorage.getItem(k))])).every((v, i) => (i === 0 ? v === RAW : v.length === 1 && v[0] === RAW)));
    await free(h, names); const done = await h.evaluate(async () => { const a = await mk().resume(); return { ok: a.ok, mode: mode() }; });
    ck(c, "after freeing space, resume completes to durable", done.ok && done.mode === "durable", done);
    await ctx.close(); }
}

// ---------------------------------------------------------------- C6
{
  const c = Case("C6", "Marker write / read-back / read failures over real Storage (fault injection on Storage.prototype; storage itself is real)", { faultInjected: true });
  const withFault = async (script, fn) => { const ctx = await ctxWith(); const h = await harness(ctx); await seed(h); await h.evaluate(script); const r = await fn(h); await ctx.close(); return r; };
  let r = await withFault(() => { const s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === "devmate-cutover-v1:workspace") throw new Error("injected marker write failure"); return s.call(this, k, v); }; },
    async (h) => ({ res: await h.evaluate(() => lifecycle("intent")), marker: await h.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace")), legacy: await h.evaluate(() => localStorage.getItem("devmate-workspace-v1")) }));
  ck(c, "marker write throws -> marker-write-failed, no marker, legacy exact", !r.res.ok && r.res.reason === "marker-write-failed" && r.marker === null && r.legacy === RAW, r.res);
  r = await withFault(() => { const s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === "devmate-cutover-v1:workspace") return; return s.call(this, k, v); }; },
    async (h) => ({ res: await h.evaluate(() => lifecycle("intent")), marker: await h.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace")), legacy: await h.evaluate(() => localStorage.getItem("devmate-workspace-v1")) }));
  ck(c, "marker write silently dropped -> marker-verify-failed (never reports success)", !r.res.ok && r.res.reason === "marker-verify-failed" && r.marker === null && r.legacy === RAW, r.res);
  { const ctx = await ctxWith(); const h = await harness(ctx); await seed(h);
    await h.evaluate(async () => { const x = mk(); await x.begin(x.preflight().plan); });
    await h.evaluate(() => { const s = Storage.prototype.setItem; window.__orig = s; Storage.prototype.setItem = function (k, v) { if (k === "devmate-cutover-v1:workspace") return; return s.call(this, k, v); }; });
    const adv = await h.evaluate(async () => { const a = await mk().advance(); return { ok: a.ok, reason: a.ok ? null : a.reason, mode: mode(), phase: JSON.parse(localStorage.getItem("devmate-cutover-v1:workspace")).phase }; });
    ck(c, "dropped advance write: verify failure, marker stays at intent", !adv.ok && adv.reason === "marker-verify-failed" && adv.phase === "intent", adv);
    await h.evaluate(() => { Storage.prototype.setItem = window.__orig; }); const done = await h.evaluate(async () => { const a = await mk().resume(); return { ok: a.ok, mode: mode() }; });
    ck(c, "after the fault is removed, resume completes forward-only", done.ok && done.mode === "durable", done);
    await ctx.close(); }
  r = await withFault(() => { const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { if (k === "devmate-cutover-v1:workspace") throw new Error("injected marker read failure"); return g.call(this, k); }; },
    async (h) => ({ inspect: await h.evaluate(() => mode()), begin: await h.evaluate(async () => { const x = mk(); const p = x.preflight(); return p.ok ? (await x.begin(p.plan)).reason : "preflight:" + p.reason; }),
      legacySave: await h.evaluate(async () => (await ctl.saveProjectsLocked([{ id: "proj-a", name: "X", tasks: [] }], undefined, null)).reason) }));
  ck(c, "marker read throws -> state indeterminate, begin refused, legacy save refused (cutover-indeterminate)", r.inspect === "indeterminate" && /marker-invalid|preflight/.test(r.begin) && r.legacySave === "cutover-indeterminate", r);
  { const ctx = await ctxWith(); const h = await harness(ctx, { init: () => { Object.defineProperty(navigator, "locks", { value: undefined, configurable: true }); } }); await seed(h);
    const res = await h.evaluate(async () => { const x = ctl.createCutoverController({ storage: localStorage, stages: ctl.createCutoverStages({ storage: localStorage }), confirmLegacyWritersQuiesced: () => true }); const p = x.preflight(); return (await x.begin(p.plan)).reason; });
    ck(c, "Web Locks unavailable -> lock-unavailable and nothing written", res === "lock-unavailable" && (await h.evaluate(() => localStorage.getItem("devmate-cutover-v1:workspace"))) === null, res);
    await ctx.close(); }
}

// ---------------------------------------------------------------- C7
{
  const c = Case("C7", "Restart at every phase and real tab kill mid-lifecycle (page.close during begin/resume), 12 trials");
  for (const phase of PHASES) {
    const ctx = await ctxWith(); const h = await harness(ctx); await seed(h); await h.evaluate((to) => lifecycle(to), phase); const s1 = await h.evaluate(() => mode()); await h.close();
    const h2 = await harness(ctx); const s2 = await h2.evaluate(() => mode()); const res = await h2.evaluate(async () => { const r = await mk().resume(); return { ok: r.ok, mode: mode() }; });
    ck(c, `restart at "${phase}": fresh page sees the same mode (${s1}) and resume reaches durable`, s1 === s2 && res.ok && res.mode === "durable", { s1, s2, res });
    await ctx.close();
  }
  const delays = [0, 1, 2, 3, 5, 8, 12, 16, 20, 30, 40, 60]; const trials = [];
  for (let i = 0; i < delays.length; i++) {
    const ctx = await ctxWith(); const a = await harness(ctx); await seed(a);
    await a.evaluate(() => { window.__run = (async () => { const x = mk(); const p = x.preflight(); await x.begin(p.plan); await x.resume(); })(); });
    await sleep(delays[i]); await a.close({ runBeforeUnload: false });
    const b = await harness(ctx);
    const seen = await b.evaluate(() => ({ mode: ctl.inspectCutoverState(localStorage).mode, legacyExact: localStorage.getItem("devmate-workspace-v1") }));
    const t0 = Date.now(); const fin = await b.evaluate(async () => { if (ctl.inspectCutoverState(localStorage).mode === "legacy") { const x = mk(); const p = x.preflight(); await x.begin(p.plan); } const r = await mk().resume(); return { ok: r.ok, mode: mode() }; });
    const stores = await profileStatus(b);
    trials.push({ killAfterMs: delays[i], modeAfterKill: seen.mode, legacyExact: seen.legacyExact === RAW, resumed: fin, resumeMs: Date.now() - t0, stores }); await ctx.close();
  }
  ck(c, "tab kill: state after kill is never indeterminate or malformed", trials.every((t) => ["legacy", "recovery", "durable"].includes(t.modeAfterKill)), trials.map((t) => t.modeAfterKill));
  ck(c, "tab kill: legacy bytes are exact after every kill", trials.every((t) => t.legacyExact));
  ck(c, "tab kill: the killed tab's Web Lock does not block recovery (resume completes quickly)", trials.every((t) => t.resumed.ok && t.resumed.mode === "durable" && t.resumeMs < 7000), trials.map((t) => t.resumeMs));
  ck(c, "tab kill: after recovery profiles and stores verify", trials.every((t) => t.stores.migrationVerified && t.stores.storesVerified));
  c.trials = trials;
}

// ---------------------------------------------------------------- C8
{
  const c = Case("C8", "Real Web Lock contention and timeout");
  const ctx = await ctxWith(); const holder = await harness(ctx); const other = await harness(ctx); await seed(holder);
  await holder.evaluate(() => new Promise((ready) => { navigator.locks.request(ctl.STORAGE_LOCK_NAME, { mode: "exclusive" }, () => new Promise((rel) => { window.__release = rel; ready(true); })); }));
  const t0 = Date.now(); const blocked = await other.evaluate(async () => { const x = mk(); const p = x.preflight(); const r = await x.begin(p.plan); return { ok: r.ok, reason: r.ok ? null : r.reason }; }); const waited = Date.now() - t0;
  ck(c, "while another tab holds the lock, begin() times out fail-closed", !blocked.ok && blocked.reason === "lock-timeout", blocked);
  ck(c, `timeout is bounded (waited ${waited} ms, expected about 8000)`, waited >= 7000 && waited < 14000, waited);
  ck(c, "no marker and no preserved copy were written while contended", (await other.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("devmate-cutover-v1")))).length === 0);
  await holder.evaluate(() => window.__release()); await sleep(50);
  const after = await other.evaluate(() => lifecycle("committed"));
  ck(c, "after the holder releases, the lifecycle completes", after.ok && after.state === "durable", after);
  await ctx.close();
}

// ---------------------------------------------------------------- C9
{
  const c = Case("C9", "Interrupted-write sweep in real Chromium: fail before / after every localStorage write (error and quota), restart, retry");
  const ctx = await ctxWith(); const h = await harness(ctx);
  await seed(h); const total = await h.evaluate(async () => { let n = 0; const s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { n++; return s.call(this, k, v); }; await lifecycle("committed"); Storage.prototype.setItem = s; return n; });
  c.totalWritesInCleanRun = total; ck(c, "clean run counted its writes", total > 5, total);
  const bad = [];
  for (const failMode of ["before", "after"]) for (const kind of ["error", "quota"]) for (let n = 0; n < total; n++) {
    await seed(h);
    const res = await h.evaluate(async ({ n, failMode, kind, RAW }) => {
      const s = Storage.prototype.setItem; let count = 0; const phases = [];
      Storage.prototype.setItem = function (k, v) { const i = count++; if (i === n) { if (failMode === "after") s.call(this, k, v); throw new DOMException("injected", kind === "quota" ? "QuotaExceededError" : "NetworkError"); } return s.call(this, k, v); };
      const obs = () => { const m = localStorage.getItem("devmate-cutover-v1:workspace"); if (m) { try { phases.push(["intent", "profiles-verified", "stores-verified", "committed"].indexOf(JSON.parse(m).phase)); } catch { phases.push(99); } } };
      try { const x = mk(); const p = x.preflight(); if (p.ok) await x.begin(p.plan); obs(); await x.resume(); } catch {}
      obs(); Storage.prototype.setItem = s;                       // "restart": injection removed, fresh controllers
      for (let a = 0; a < 4 && mode() !== "durable"; a++) { const x = mk(); if (x.inspect().mode === "legacy") { const p = x.preflight(); if (p.ok) await x.begin(p.plan); } obs(); await x.resume(); obs(); }
      const monotonic = phases.every((v, i) => i === 0 || v >= phases[i - 1]);
      return { mode: mode(), legacyExact: localStorage.getItem("devmate-workspace-v1") === RAW, monotonic, phases };
    }, { n, failMode, kind, RAW });
    const st = await profileStatus(h);
    if (!(res.mode === "durable" && res.legacyExact && res.monotonic && st.migrationVerified && st.storesVerified)) bad.push({ failMode, kind, n, res, st });
  }
  ck(c, `all ${total * 4} injected failure points recover to durable with exact legacy bytes, monotonic phases and verified stores`, bad.length === 0, bad.slice(0, 3));
  await ctx.close();
}

// ---------------------------------------------------------------- C10
{
  const c = Case("C10", "Live refresh in a real open tab: another tab's write is shown without a reload (real storage events)");
  const trackWrites = () => { window.__writes = []; window.__noReload = true; const s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { window.__writes.push(k); return s.call(this, k, v); }; };
  { // 10a: an already-loaded pre-barrier tab writes after intent while the new app is open
    const ctx = await ctxWith();
    const oldTab = await ctx.newPage(); await oldTab.goto(origin + "/__h.html");
    const h = await harness(ctx); await seed(h); await h.evaluate(() => lifecycle("intent"));
    const app = await ctx.newPage(); await app.addInitScript(trackWrites); await app.goto(origin + "/"); await app.waitForSelector('[data-testid="recovery-archive"]');
    ck(c, "10a before the old write: recovery status, no alert", (await app.locator('[data-testid="cutover-banner"]').getAttribute("role")) === "status");
    const w = await oldTab.evaluate(async () => legacy.saveProjectsLocked([{ id: "proj-a", name: "EDITED LIVE BY OLD TAB", tasks: [] }], undefined, localStorage.getItem("devmate-workspace-v1")));
    ck(c, "10a the old writer succeeds (R1 limitation again)", w.ok === true);
    let flipped = true; try { await app.waitForFunction(() => document.querySelector('[data-testid="cutover-banner"]')?.getAttribute("role") === "alert", null, { timeout: 5000 }); } catch { flipped = false; }
    ck(c, "10a the open page flips to an alert WITHOUT reloading", flipped && (await app.evaluate(() => window.__noReload === true)));
    ck(c, "10a the alert names the divergence and states the real limitation", /source-changed/.test(await app.locator('[data-testid="cutover-banner"]').innerText()) && /cannot stop an older copy of the app/.test(await app.locator('[data-testid="cutover-banner"]').innerText()));
    ck(c, "10a the current (diverged) source appears live and editing stays locked", (await app.locator('[data-testid="archive-source-current"]').count()) === 1 && !(await app.locator('input[aria-label="New project name"]').isEnabled()));
    ck(c, "10a the page made no storage write while refreshing", (await app.evaluate(() => window.__writes)).length === 0, await app.evaluate(() => window.__writes));
    await ctx.close();
  }
  { // 10b: a marker appears while the app is open in legacy mode
    const ctx = await ctxWith(); const h = await harness(ctx); await seed(h);
    const app = await ctx.newPage(); await app.addInitScript(trackWrites); await app.goto(origin + "/"); await app.waitForSelector('input[aria-label="New project name"]');
    ck(c, "10b legacy mode: editing enabled before the marker", await app.locator('input[aria-label="New project name"]').isEnabled());
    await h.evaluate(() => lifecycle("intent"));
    let locked = true; try { await app.waitForSelector('[data-testid="recovery-archive"]', { timeout: 5000 }); } catch { locked = false; }
    ck(c, "10b the open page locks editing and shows the recovery panel without reloading", locked && !(await app.locator('input[aria-label="New project name"]').isEnabled()) && (await app.evaluate(() => window.__noReload === true)));
    const wrote = await app.evaluate(() => window.__writes); ck(c, "10b the page made no storage write", wrote.length === 0, wrote);
    await ctx.close();
  }
}

await browser.close(); server.close();
results.summary = { cases: results.cases.length, checks: results.cases.reduce((n, c) => n + c.checks.length, 0), failedChecks: failures, passed: failures === 0 };
writeFileSync(here + "results.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results.summary), "chromium", results.environment.chromium);
process.exit(failures === 0 ? 0 : 1);
