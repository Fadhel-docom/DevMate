// DIAGNOSTIC (not part of the S2 results): measures, inside the real production saveProjectsLocked, what the
// compare-read of STORAGE_KEY returns in the second tab relative to the first tab's completed write.
// Only read-only logging wrappers around Storage.prototype and navigator.locks.request are installed; no production code is changed.
// Usage: node e2e/s2-browser-persistence/diag-s2-16.mjs [trials=60]  -> out/diag-s2-16.json
import { createRequire } from "node:module";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const esbuild = (() => { for (const id of [process.env.ESBUILD_MODULE, "esbuild", "/opt/npm-tools/node_modules/esbuild"]) { if (!id) continue; try { return require(id); } catch { /* next */ } } throw new Error("esbuild not found"); })();
const here = new URL(".", import.meta.url).pathname, out = here + "out/"; mkdirSync(out, { recursive: true });
esbuild.buildSync({ entryPoints: [here + "entry-current.ts"], bundle: true, format: "iife", globalName: "cur", outfile: `${out}cur.js`, logLevel: "error" });
const PORT = 18766, origin = `http://localhost:${PORT}`, TRIALS = Number(process.argv[2] ?? 60), HOLD = Number(process.argv[3] ?? 0); // HOLD>0: DIAGNOSTIC VARIANT that keeps the lock HOLD ms after the write (what a mitigation could look like); 0 = the real saveProjectsLocked
const server = http.createServer((req, res) => { res.setHeader("cache-control", "no-store"); if (req.url.startsWith("/cur.js")) { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(out + "cur.js")); } else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><meta charset="utf-8"><script src="/cur.js"></script><body>d</body>'); } });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const RAW = JSON.stringify([{ id: "p1", name: "Alpha", tasks: [{ id: "t1", title: "first", done: false, createdAt: 1 }] }, { id: "p2", name: "Beta", tasks: [] }]);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], channel: "chromium" }).catch(() => chromium.launch({ headless: true, args: ["--no-sandbox"] }));
const INSTALL = () => {
  const K = "devmate-workspace-v1", now = () => performance.timeOrigin + performance.now(); window.__L = [];
  const g = Storage.prototype.getItem, st = Storage.prototype.setItem;
  Storage.prototype.getItem = function (k) { const v = g.call(this, k); if (this === localStorage && k === K) window.__L.push({ t: now(), op: "get", v: window.__lab ? window.__lab(v) : "?" }); return v; };
  Storage.prototype.setItem = function (k, v) { const r = st.call(this, k, v); if (this === localStorage && k === K) window.__L.push({ t: now(), op: "set", v: window.__lab ? window.__lab(v) : "?" }); return r; };
  const req = navigator.locks.request.bind(navigator.locks);
  navigator.locks.request = (name, opts, cb) => req(name, opts, async (lock) => { window.__L.push({ t: now(), op: "lock-granted" }); try { return await cb(lock); } finally { window.__L.push({ t: now(), op: "lock-callback-done" }); } });
};
const rows = [];
for (let t = 0; t < TRIALS; t++) {
  const ctx = await browser.newContext(); const a = await ctx.newPage(), b = await ctx.newPage();
  await Promise.all([a.goto(origin), b.goto(origin)]); await a.evaluate((raw) => localStorage.setItem("devmate-workspace-v1", raw), RAW); await new Promise((r) => setTimeout(r, 150));
  for (const p of [a, b]) await p.evaluate(INSTALL);
  for (const [p, who] of [[a, "a"], [b, "b"]]) await p.evaluate(async ({ who, RAW }) => {
    const r = await cur.storage.readProjectsLocked(); window.__base = r.storageRaw; window.__L.length = 0; window.__lab = (v) => (v === null ? "null" : v === window.__base ? "baseline" : v.includes(`D-${who}`) ? "own-write" : "other-tab-write"); window.__who = who;
    return r.storageRaw === RAW;
  }, { who, RAW });
  const go = (p, who) => p.evaluate(async ({ who, hold }) => { const ps = JSON.parse(window.__base); ps[0].tasks.push({ id: `D-${who}`, title: `D-${who}`, done: false, createdAt: 1 }); let r; if (hold > 0) { const l = await cur.storage.withStorageLock(async () => { const x = cur.storage.saveProjects(ps, undefined, window.__base); await new Promise((z) => setTimeout(z, hold)); return x; }); r = l.ok ? l.value : { ok: false, reason: l.reason }; } else r = await cur.storage.saveProjectsLocked(ps, undefined, window.__base); return { ok: r.ok, reason: r.ok ? null : r.reason, log: window.__L.slice() }; }, { who, hold: HOLD });
  const [ra, rb] = await Promise.all([go(a, "a"), go(b, "b")]);
  await new Promise((r) => setTimeout(r, 300));
  const final = JSON.parse(await a.evaluate(() => localStorage.getItem("devmate-workspace-v1")))[0].tasks.map((x) => x.title).filter((x) => x.startsWith("D-"));
  rows.push({ t, ra, rb, final }); await ctx.close();
}
// classify: the tab whose lock was granted second ("late") and whether its in-lock compare read saw the first tab's finished write
const analysis = rows.map((r) => {
  const ev = (x) => ({ grant: x.log.find((e) => e.op === "lock-granted")?.t, done: x.log.find((e) => e.op === "lock-callback-done")?.t, gets: x.log.filter((e) => e.op === "get" && e.t >= (x.log.find((e2) => e2.op === "lock-granted")?.t ?? 0)), set: x.log.find((e) => e.op === "set") });
  const A = ev(r.ra), B = ev(r.rb); const [first, second, fr, sr, fname] = A.grant <= B.grant ? [A, B, r.ra, r.rb, "a"] : [B, A, r.rb, r.ra, "b"];
  const firstDoneBeforeSecondGrant = first.done !== undefined && first.done <= second.grant;
  const secondFirstRead = second.gets[0]?.v ?? null;
  return { t: r.t, bothOk: r.ra.ok && r.rb.ok, firstTab: fname, locksSerialised: firstDoneBeforeSecondGrant, gapMs: second.grant - first.done, firstSetBeforeSecondGrantMs: first.set ? second.grant - first.set.t : null, secondTabCompareReadSaw: secondFirstRead, secondOk: sr.ok, secondReason: sr.reason, firstOk: fr.ok, acknowledgedMissing: [r.ra.ok && !r.final.includes("D-a") ? "a" : null, r.rb.ok && !r.final.includes("D-b") ? "b" : null].filter(Boolean) };
});
const summary = {
  trials: analysis.length, bothOk: analysis.filter((x) => x.bothOk).length, locksSerialisedEveryTrial: analysis.every((x) => x.locksSerialised),
  bothOk_secondCompareReadSawBaselineAfterFirstWriteFinished: analysis.filter((x) => x.bothOk && x.secondTabCompareReadSaw === "baseline" && x.firstSetBeforeSecondGrantMs > 0).length,
  bothOk_byWhatSecondCompareReadSaw: Object.fromEntries(["baseline", "other-tab-write", "own-write", "null"].map((k) => [k, analysis.filter((x) => x.bothOk && x.secondTabCompareReadSaw === k).length])),
  conflict_byWhatSecondCompareReadSaw: Object.fromEntries(["baseline", "other-tab-write", "own-write", "null"].map((k) => [k, analysis.filter((x) => !x.bothOk && x.secondReason === "conflict" && x.secondTabCompareReadSaw === k).length])),
  gapBetweenFirstLockReleaseAndSecondGrantMs: { min: Math.min(...analysis.map((x) => x.gapMs)), max: Math.max(...analysis.map((x) => x.gapMs)) },
  acknowledgedButMissing: analysis.reduce((n, x) => n + x.acknowledgedMissing.length, 0)
};
const meta = { holdMs: HOLD, variant: HOLD > 0 ? "diagnostic lock-hold variant (NOT production code)" : "real saveProjectsLocked", chromium: browser.version(), playwright: require("playwright/package.json").version, node: process.version, os: `${os.type()} ${os.release()}`, at: new Date().toISOString() };
writeFileSync(out + `diag-s2-16-hold${HOLD}.json`, JSON.stringify({ meta, summary, analysis, rows }, null, 1) + "\n");
console.log(JSON.stringify({ meta, summary }, null, 1)); await browser.close(); server.close();
