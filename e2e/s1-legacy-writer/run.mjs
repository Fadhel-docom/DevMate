// Real-Chromium evidence for S1/R1. Not part of `npm test`; Playwright is NOT a repo dependency.
// Usage: node e2e/s1-legacy-writer/run.mjs  (needs: playwright + a Chromium it can launch; see README.md)
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { page } from "./pages.mjs";

const here = new URL(".", import.meta.url).pathname, out = here + "out/";
mkdirSync(out, { recursive: true });
const esbuild = new URL("../../node_modules/esbuild/bin/esbuild", import.meta.url).pathname;
for (const [entry, name] of [["entry-current.ts", "current"], ["entry-legacy.ts", "legacy"]])
  execFileSync(esbuild, [here + entry, "--bundle", "--format=iife", `--global-name=${name}`, `--outfile=${out}${name}.js`, "--log-level=error"]);

const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/new.html") { res.setHeader("content-type", "text/html"); res.end(page("current", "new")); }
  else if (u === "/old.html") { res.setHeader("content-type", "text/html"); res.end(page("legacy", "old")); }
  else if (u === "/current.js" || u === "/legacy.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(out + u.slice(1))); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${server.address().port}`;
const RAW = JSON.stringify([{ id: "p1", name: "original", tasks: [] }]);
const results = { chromium: null, origin: "http://localhost:<ephemeral>", scenarios: {} };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
results.chromium = browser.version();

async function setup() {
  const ctx = await browser.newContext();
  const oldTab = await ctx.newPage(); await oldTab.goto(origin + "/old.html");   // loaded BEFORE the barrier is declared
  const newTab = await ctx.newPage(); await newTab.goto(origin + "/new.html");
  await newTab.evaluate((raw) => localStorage.setItem("devmate-workspace-v1", raw), RAW);
  return { ctx, oldTab, newTab };
}
const drive = (tab, target) => tab.evaluate(async (target) => {
  // Test-only quiescence callback: lets the lifecycle run. It is NOT evidence that any writer stopped.
  const ok = async () => ({ ok: true });
  const c = current.createCutoverController({ storage: localStorage, stages: { migrateProfiles: ok, verifyProfiles: ok, verifyStores: ok }, confirmLegacyWritersQuiesced: () => true });
  const plan = c.preflight(); const began = await c.begin(plan.plan);
  let resumed = null; if (target === "committed") resumed = await c.resume();
  return { began: began.ok, resumed: resumed ? resumed.ok : null, mode: current.readCutoverState(localStorage).mode, locksType: typeof navigator.locks };
}, target);
const oldWrite = (tab, name, expected) => tab.evaluate(async ([name, expected]) =>
  legacy.saveProjectsLocked([{ id: "p1", name, tasks: [] }], undefined, expected), [name, expected]);
const legacyRaw = (tab) => tab.evaluate(() => localStorage.getItem("devmate-workspace-v1"));
const inspect = (tab) => tab.evaluate(() => current.createCutoverController({ storage: localStorage, stages: {}, runExclusive: async (w) => ({ ok: true, value: await w() }) }).inspect().mode);

const TRIALS = 5;
for (const target of ["intent", "committed"]) {
  const trials = [];
  for (let i = 0; i < TRIALS; i++) {
    const { ctx, oldTab, newTab } = await setup();
    const state = await drive(newTab, target);
    const write = await oldWrite(oldTab, `old-bundle-after-${target}`, RAW);
    const writerSees = await legacyRaw(oldTab);
    const immediate = await legacyRaw(newTab);        // new tab reads right after the old tab's write returned
    const inspectImmediate = await inspect(newTab);
    let settledAfterMs = null; const t0 = Date.now();
    while (Date.now() - t0 < 3000) { if ((await legacyRaw(newTab)) === writerSees) { settledAfterMs = Date.now() - t0; break; } await new Promise((r) => setTimeout(r, 25)); }
    trials.push({ oldWriteOk: write.ok, writerSeesNewValue: writerSees !== RAW, newTabImmediateReadStale: immediate === RAW, inspectImmediate, newTabSettledAfterMs: settledAfterMs, inspectSettled: await inspect(newTab), state });
    await ctx.close();
  }
  results.scenarios[`old-writer-after-${target}`] = { trials };
}

{ // Separate MITIGATION experiment (not a fix): a live tab holds the real exclusive lock.
  const { ctx, oldTab, newTab } = await setup();
  await drive(newTab, "intent");
  await newTab.evaluate(() => { window.__held = new Promise((r) => { navigator.locks.request("devmate-workspace-v1", { mode: "exclusive" }, () => new Promise((rel) => { window.__release = rel; r(true); })); }); return window.__held; });
  const t0 = Date.now(); const blocked = await oldWrite(oldTab, "old-while-lock-held", RAW); const waitedMs = Date.now() - t0;
  const afterBlocked = await legacyRaw(oldTab);
  await newTab.close(); // holder disappears (tab closed)
  const afterHolderGone = await oldWrite(oldTab, "old-after-holder-closed", RAW);
  results.scenarios["lock-held-mitigation-experiment"] = {
    whileHeld: { ok: blocked.ok, reason: blocked.reason ?? null, waitedMs, legacyUnchanged: afterBlocked === RAW },
    afterHolderClosed: { ok: afterHolderGone.ok, reason: afterHolderGone.reason ?? null, legacyChanged: (await legacyRaw(oldTab)) !== RAW }
  };
  await ctx.close();
}
await browser.close(); server.close();
writeFileSync(here + "results.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
