// Race actor for the IndexedDB CAS harness. One instance runs in a Dedicated Worker hosted by each tab, so the two
// racers have independent event loops: a spin in one cannot block message delivery to the other. Test-only file.
import { openCasStore, CAS_DB_NAME } from "/src/casStore/indexedDbCasStore.ts";

const role = self.name; // "parent" or "worker"
const other = role === "parent" ? "worker" : "parent";
const channel = new BroadcastChannel("devmate-cas-p1-harness");
const nowMs = () => Date.now(); // wall clock, shared by all threads of this browser
const describe = (e) => `${e?.name ?? "Error"}: ${e?.message ?? e}`;
const post = (message) => channel.postMessage({ ...message, role });

self.addEventListener("error", (event) => post({ type: "racer-exception", message: `uncaught: ${describe(event.error ?? event.message)}` }));
self.addEventListener("unhandledrejection", (event) => post({ type: "racer-exception", message: `unhandledrejection: ${describe(event.reason)}` }));

const waiters = new Set();
channel.addEventListener("message", (event) => {
  for (const waiter of [...waiters]) {
    if (waiter.match(event.data)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event.data); }
  }
});
const waitFor = (match, ms, label) => {
  const promise = new Promise((resolve, reject) => {
    const waiter = { match, resolve };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout after ${ms}ms waiting for ${label}`)); }, ms);
    waiters.add(waiter);
  });
  promise.catch(() => {});
  return promise;
};

const openRawDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(CAS_DB_NAME, 1);
  request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("racer database open was blocked"));
});
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
});
const getWorkspace = (db) => new Promise((resolve, reject) => {
  const tx = db.transaction(["records"], "readonly");
  const request = tx.objectStore("records").get("workspace");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const store = await openCasStore();
const rawDb = await openRawDb();

// NEGATIVE CONTROL (race): read-then-write in separate steps, no CAS inside the write transaction.
// A barrier forces both racers to hold the same stale baseline before either writes.
async function mutantReadThenWrite({ trial, expectedVersion, raw, barrier }) {
  const current = await getWorkspace(rawDb);
  const actual = current?.version ?? 0;
  if (actual !== expectedVersion) return { ok: false, conflict: true, actualVersion: actual };
  channel.postMessage({ type: "mutant-read", trial, who: role, version: actual });
  await barrier;
  const tx = rawDb.transaction(["records", "backups"], "readwrite");
  if (current) tx.objectStore("backups").add({ raw: current.raw, reason: "pre-write", sourceVersion: current.version, createdAt: Date.now(), writer: role });
  tx.objectStore("records").put({ name: "workspace", version: actual + 1, raw, updatedAt: Date.now(), writer: role });
  await txDone(tx);
  return { ok: true, version: actual + 1 };
}

let armed = null;
channel.addEventListener("message", async ({ data }) => {
  if (!data) return;
  if (data.type === "racer-prepare") {
    armed = {
      trial: data.trial, mode: data.mode, expectedVersion: data.expectedVersion, raw: data.raws[role], delayMs: data.delays[role],
      barrier: data.mode === "mutant" ? waitFor((m) => m?.type === "mutant-read" && m.trial === data.trial && m.who === other, 15000, `mutant barrier (${data.trial})`) : null
    };
    post({ type: "racer-ready", trial: data.trial, at: nowMs() });
  } else if (data.type === "racer-go") {
    const goReceivedAt = nowMs();
    if (!armed || armed.trial !== data.trial) {
      post({ type: "racer-result", trial: data.trial, protocolViolation: true, goReceivedAt, startedAt: goReceivedAt, finishedAt: goReceivedAt, result: { ok: false, error: "protocol" } });
      return;
    }
    const run = armed; armed = null;
    try {
      while (Date.now() < data.startAt + run.delayMs) { /* spin: this worker thread only */ }
      const startedAt = nowMs();
      const result = run.mode === "mutant"
        ? await mutantReadThenWrite({ trial: run.trial, expectedVersion: run.expectedVersion, raw: run.raw, barrier: run.barrier })
        : await store.write({ expectedVersion: run.expectedVersion, raw: run.raw, writer: role });
      post({ type: "racer-result", trial: run.trial, goReceivedAt, startedAt, finishedAt: nowMs(), result });
    } catch (error) {
      post({ type: "racer-result", trial: run.trial, goReceivedAt, startedAt: goReceivedAt, finishedAt: nowMs(), result: { ok: false, error: String(error) } });
    }
  } else if (data.type === "racer-spin" && data.role === role) {
    post({ type: "racer-spin-started", id: data.id, at: nowMs() });
    const until = Date.now() + data.ms; while (Date.now() < until) { /* spin */ }
    post({ type: "racer-spin-done", id: data.id, endedAt: nowMs() });
  } else if (data.type === "racer-probe" && data.role === role) {
    post({ type: "racer-probe-ack", id: data.id, receivedAt: nowMs() });
  } else if (data.type === "racer-selftest-throw" && data.role === role) {
    // Runner self-test only (selftest=racer-exception): throw from a timer so the error is genuinely UNCAUGHT inside this
    // Dedicated Worker and travels through the self.addEventListener("error") monitor above. Never sent in a normal run.
    setTimeout(() => { throw new Error("SELFTEST racer uncaught exception"); }, 0);
  } else if (data.type === "racer-stop") {
    try { store.close(); } catch { /* already closed */ }
    try { rawDb.close(); } catch { /* already closed */ }
    post({ type: "racer-stopped" });
    channel.close();
    self.close();
  }
});
post({ type: "racer-up" });
