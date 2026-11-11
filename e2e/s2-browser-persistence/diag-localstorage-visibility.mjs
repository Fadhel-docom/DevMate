// DIAGNOSTIC (not part of the S2 results): how long after tab A's localStorage.setItem returns does tab B's getItem first return the new value?
// Independent of production code: plain localStorage + two real Chromium pages of one origin. B polls with MessageChannel task yields (no setTimeout clamp), bounded to 500 ms.
// Usage: node e2e/s2-browser-persistence/diag-localstorage-visibility.mjs [trials=200] [mc|timeout]  -> out/diag-localstorage-visibility-<mode>.json
import { createRequire } from "node:module";
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = new URL(".", import.meta.url).pathname, out = here + "out/"; mkdirSync(out, { recursive: true });
const TRIALS = Number(process.argv[2] ?? 200), YIELD = process.argv[3] ?? "mc";   // "mc" = MessageChannel yield (sub-ms resolution, can starve a 1-CPU host); "timeout" = setTimeout(0) (about 4 ms resolution, polite)
const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><meta charset=utf-8><body>v"); });
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext(); const a = await ctx.newPage(), b = await ctx.newPage(); await Promise.all([a.goto(origin), b.goto(origin)]);
const rows = [];
for (let i = 0; i < TRIALS; i++) {
  const key = YIELD + "k" + i;                                   // fresh key per trial: no stale pre-existing value can be confused with the new one
  const poll = b.evaluate(async ({ key, YIELD }) => {               // B starts polling BEFORE A writes; records when it first sees the value
    const start = performance.timeOrigin + performance.now(); const deadline = performance.now() + 500;
    while (performance.now() < deadline) { const v = localStorage.getItem(key); if (v !== null) return { seenAt: performance.timeOrigin + performance.now(), start }; await new Promise((r) => { if (YIELD === "timeout") setTimeout(r, 0); else { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); } }); }
    return { seenAt: null, start };
  }, { key, YIELD });
  await new Promise((r) => setTimeout(r, 20));
  const wrote = await a.evaluate((key) => { localStorage.setItem(key, "1"); return performance.timeOrigin + performance.now(); }, key);
  const r = await poll; rows.push({ i, latencyMs: r.seenAt === null ? null : r.seenAt - wrote });
}
const ok = rows.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs).sort((x, y) => x - y); const pct = (p) => ok[Math.min(ok.length - 1, Math.floor(p * ok.length))];
const summary = { yield: YIELD, trials: TRIALS, neverSeenWithin500ms: rows.length - ok.length, minMs: ok[0], p50Ms: pct(0.5), p95Ms: pct(0.95), p99Ms: pct(0.99), maxMs: ok.at(-1), negativeOrZero: ok.filter((x) => x <= 0).length, note: "latency = B first read of the new value minus A's timestamp right after setItem returned; per-page timeOrigin skew is about 0.1 ms" };
const meta = { chromium: browser.version(), playwright: require("playwright/package.json").version, node: process.version, os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, memMB: Math.round(os.totalmem() / 1048576), at: new Date().toISOString() };
writeFileSync(out + `diag-localstorage-visibility-${YIELD}.json`, JSON.stringify({ meta, summary, rows }, null, 1) + "\n");
console.log(JSON.stringify({ meta, summary }, null, 1)); await browser.close(); server.close();
