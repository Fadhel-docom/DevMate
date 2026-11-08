import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.DEVMATE_TEST_URL ?? "http://127.0.0.1:4173";
const harnessQuery = process.env.DEVMATE_HARNESS_QUERY ?? "";
const chromiumBin = process.env.CHROMIUM_BIN ?? "chromium";
const overallTimeoutMs = Number(process.env.DEVMATE_HARNESS_TIMEOUT_MS ?? 240000);
// A passing run must have executed every one of these checks (guards against silently skipped checks).
const REQUIRED_CHECKS = [
  "ATOMICITY-REAL", "ATOMICITY-MUTANT-SPLIT", "RACE-REAL", "RACE-MUTANT",
  "BACKUP-LIMIT", "ERRCLASS-REQUEST-ERROR", "VERSIONCHANGE-FAIL-CLOSED"
];

const chromiumVersion = spawnSync(chromiumBin, ["--version"], { encoding: "utf8" });
if (chromiumVersion.status !== 0) throw new Error(`Unable to execute ${chromiumBin}: ${chromiumVersion.stderr}`);
console.log(`ENV chromium=${chromiumVersion.stdout.trim()}`);
console.log(`ENV node=${process.version} platform=${process.platform} arch=${process.arch}`);
try {
  const osRelease = readFileSync("/etc/os-release", "utf8");
  console.log(`ENV os=${osRelease.match(/^PRETTY_NAME="?(.*?)"?$/m)?.[1] ?? "unknown"}`);
} catch { console.log("ENV os=unknown"); }

// Fresh profile and an OS-assigned debugging port: no state or port shared with other processes or earlier runs.
const profileDir = mkdtempSync(join(tmpdir(), "devmate-p1-chromium-"));
let stderrTail = "";
const browser = spawn(chromiumBin, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-popup-blocking",
  "--remote-debugging-port=0",
  "--remote-allow-origins=*",
  `--user-data-dir=${profileDir}`,
  "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
browser.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000); });

const problems = [];
const attached = new Map();
const sockets = [];

async function attach(target, label) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let commandId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      const text = `${details.text} ${details.exception?.description ?? ""}`.trim();
      problems.push(`[${label}] uncaught exception: ${text}`);
      console.error("BROWSER_EXCEPTION", `[${label}]`, text);
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      const entry = message.params.entry;
      const text = `${entry.text}${entry.url ? ` (${entry.url})` : ""}`;
      problems.push(`[${label}] console error: ${text}`);
      console.error("BROWSER_CONSOLE", `[${label}]`, text);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  attached.set(target.id, label);
  return cdp;
}

let port;
async function scanTargets(mainTargetId) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  for (const target of list) {
    if (target.type !== "page" || target.id === mainTargetId || attached.has(target.id) || !target.webSocketDebuggerUrl) continue;
    attached.set(target.id, "attaching");
    try { await attach(target, `tab:${target.url}`); } catch { attached.delete(target.id); }
  }
}

try {
  const portFile = join(profileDir, "DevToolsActivePort");
  for (let i = 0; i < 150 && port === undefined; i++) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (first) port = Number(first);
    }
    if (port === undefined) {
      if (browser.exitCode !== null) throw new Error(`Chromium exited early with code ${browser.exitCode}`);
      await delay(100);
    }
  }
  if (port === undefined) throw new Error("Chromium did not publish a DevTools port");
  const versionInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  console.log(`ENV browser=${versionInfo.Browser} devtoolsPort=${port}`);

  const pageUrl = `${baseUrl}/e2e/cas-store-harness/${harnessQuery}`;
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`, { method: "PUT" });
  if (!targetResponse.ok) throw new Error(`Unable to create Chromium page: HTTP ${targetResponse.status}`);
  const target = await targetResponse.json();
  const cdp = await attach(target, "page");
  console.log(`ENV harness-url=${pageUrl}`);

  const deadline = Date.now() + overallTimeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    await scanTargets(target.id); // attaches the popup/worker tab as soon as Chromium lists it
    if (problems.length > 0) break; // fail fast on any page or worker exception / console error
    try {
      const result = await cdp("Runtime.evaluate", {
        expression: "JSON.stringify({ s: window.__casHarness ?? null, out: document.querySelector('#output')?.textContent ?? '' })",
        returnByValue: true
      });
      state = JSON.parse(result.result?.value ?? "null");
    } catch {}
    if (state?.s && state.s.status !== "running") break;
    await delay(250);
  }
  const output = state?.out ?? "";
  if (problems.length > 0) {
    throw new Error(`Chromium reported ${problems.length} page/worker problem(s):\n${problems.join("\n")}\nLast harness output:\n${output}`);
  }
  if (!state?.s || state.s.status === "running") {
    throw new Error(`Chromium harness did not finish within ${overallTimeoutMs}ms. Last output:\n${output}`);
  }
  if (state.s.status !== "pass") throw new Error(`Chromium harness failed: ${state.s.message}\n${output}`);
  await delay(1000);
  await scanTargets(target.id);
  if (problems.length > 0) throw new Error(`Chromium reported late problem(s):\n${problems.join("\n")}`);
  const missing = REQUIRED_CHECKS.filter((name) => !state.s.checks.includes(name));
  if (missing.length > 0) throw new Error(`Required checks did not pass or did not run: ${missing.join(", ")}`);
  console.log(`ENV monitored-targets=${[...attached.values()].join(" | ")}`);
  console.log("CHROMIUM_HARNESS_RESULT");
  console.log(output);
  console.log("CHROMIUM_HARNESS_EXIT=PASS");
} catch (error) {
  console.error(`CHROMIUM_STDERR_TAIL\n${stderrTail}`);
  throw error;
} finally {
  for (const socket of sockets) { try { socket.close(); } catch {} }
  browser.kill("SIGTERM");
  await delay(500);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
