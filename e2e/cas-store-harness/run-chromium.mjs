import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.DEVMATE_TEST_URL ?? "http://127.0.0.1:4173";
const chromiumBin = process.env.CHROMIUM_BIN ?? "chromium";
const chromiumVersion = spawnSync(chromiumBin, ["--version"], { encoding: "utf8" });
if (chromiumVersion.status !== 0) throw new Error(`Unable to execute ${chromiumBin}: ${chromiumVersion.stderr}`);
console.log(`ENV chromium=${chromiumVersion.stdout.trim()}`);
console.log(`ENV node=${process.version} platform=${process.platform} arch=${process.arch}`);

const browser = spawn(chromiumBin, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-popup-blocking",
  "--remote-debugging-port=9222",
  "--remote-allow-origins=*",
  "--user-data-dir=/tmp/devmate-p1-chromium-profile",
  "about:blank"
], { stdio: "ignore" });

let socket;
try {
  let versionInfo;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch("http://127.0.0.1:9222/json/version");
      if (response.ok) { versionInfo = await response.json(); break; }
    } catch {}
    if (browser.exitCode !== null) throw new Error(`Chromium exited early with code ${browser.exitCode}`);
    await delay(100);
  }
  if (!versionInfo) throw new Error("Chromium DevTools endpoint did not become ready");
  console.log(`ENV browser=${versionInfo.Browser}`);

  const targetResponse = await fetch(
    `http://127.0.0.1:9222/json/new?${encodeURIComponent(`${baseUrl}/e2e/cas-store-harness/`)}`,
    { method: "PUT" }
  );
  if (!targetResponse.ok) throw new Error(`Unable to create Chromium page: HTTP ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
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
      console.error("BROWSER_EXCEPTION", details.text, details.exception?.description ?? "");
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params.entry;
      if (entry.level === "error") console.error("BROWSER_CONSOLE", entry.text);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await cdp("Runtime.enable");
  await cdp("Log.enable");

  const deadline = Date.now() + 120000;
  let output = "";
  while (Date.now() < deadline) {
    try {
      const result = await cdp("Runtime.evaluate", {
        expression: "document.querySelector('#output')?.textContent ?? ''",
        returnByValue: true,
        awaitPromise: true
      });
      output = result.result?.value ?? "";
    } catch {}
    if (output.includes("BACKUP-FAILURE PASS") && output.includes("PASS: successes=100, conflicts=100")) break;
    if (output.includes("FAIL") || output.includes("Error:") || output.includes("OPEN FAILED")) {
      throw new Error(`Chromium harness failed:\\n${output}`);
    }
    await delay(250);
  }
  if (!output.includes("BACKUP-FAILURE PASS") || !output.includes("PASS: successes=100, conflicts=100")) {
    throw new Error(`Chromium harness timed out. Last output:\\n${output}`);
  }
  console.log("CHROMIUM_HARNESS_RESULT");
  console.log(output);
  console.log("CHROMIUM_HARNESS_EXIT=PASS");
} finally {
  try { socket?.close(); } catch {}
  browser.kill("SIGTERM");
}
