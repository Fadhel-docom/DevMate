import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUTOVER_MARKER_KEY, createCutoverController, readCutoverState, type CutoverStages } from "./cutoverController";
import { STORAGE_KEY, STORAGE_LOCK_NAME } from "./storage";
import legacySource from "./__fixtures__/legacyStorage.base.ts?raw";
import { saveProjectsLocked as legacySaveProjectsLocked, STORAGE_KEY as LEGACY_STORAGE_KEY } from "./__fixtures__/legacyStorage.base";

/**
 * S1 evidence (R1). The "legacy writer" below is the UNMODIFIED src/storage.ts of base revision 3c60a85
 * (feature/phase-1-foundation), i.e. the code an already-loaded pre-barrier tab keeps executing.
 * navigator.locks is a spec-shaped in-memory FAKE (exclusive mode, FIFO queue, AbortSignal on queued requests).
 * These tests are therefore a simulation: they prove what the old code does, not how a real browser schedules locks.
 * Real-browser confirmation belongs to S2 and is NOT claimed here.
 */
const BASE_FIXTURE_SHA256 = "91ffc4cd07135d62933da4e742e9e57eb38159f47d2746f5c71f4814b69bc5f4";

class FakeLockManager {
  private held = new Set<string>();
  private queues = new Map<string, Array<() => void>>();
  request(name: string, options: { mode?: string; signal?: AbortSignal }, callback: () => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.held.add(name);
        try { resolve(await callback()); } catch (error) { reject(error); }
        finally { this.held.delete(name); const next = this.queues.get(name)?.shift(); if (next) next(); }
      };
      if (!this.held.has(name)) { void run(); return; }
      const queue = this.queues.get(name) ?? []; this.queues.set(name, queue);
      const entry = () => { options.signal?.removeEventListener("abort", onAbort); void run(); };
      const onAbort = () => {
        const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1);
        const error = new Error("aborted"); error.name = "AbortError"; reject(error);
      };
      queue.push(entry);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const okStages: CutoverStages = {
  migrateProfiles: async () => ({ ok: true }), verifyProfiles: async () => ({ ok: true }), verifyStores: async () => ({ ok: true })
} as unknown as CutoverStages;
const noLock = async <R>(work: () => R | Promise<R>) => ({ ok: true as const, value: await work() });
const project = (name: string) => [{ id: "p1", name, tasks: [] }];
const LEGACY_RAW = JSON.stringify(project("original"));

let originalLocks: unknown;
beforeEach(() => {
  localStorage.clear();
  originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { value: new FakeLockManager(), configurable: true });
  localStorage.setItem(STORAGE_KEY, LEGACY_RAW);
});
afterEach(() => {
  vi.useRealTimers();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks as PropertyDescriptor); else delete (navigator as unknown as Record<string, unknown>).locks;
});

function controller() {
  // Test-only quiescence "proof" so the lifecycle can be driven. It is NOT evidence that any legacy writer stopped.
  return createCutoverController({ storage: localStorage, stages: okStages, runExclusive: noLock, confirmLegacyWritersQuiesced: () => true });
}
async function reach(phase: "intent" | "committed") {
  const c = controller();
  const plan = c.preflight(); if (!plan.ok) throw new Error("preflight failed");
  expect((await c.begin(plan.plan)).ok).toBe(true);
  if (phase === "committed") { const r = await c.resume(); expect(r.ok).toBe(true); expect(readCutoverState(localStorage).mode).toBe("durable"); }
  return c;
}

describe("S1 / R1 — pre-barrier writer evidence (base revision 3c60a85 storage.ts)", () => {
  it("fixture is the unmodified base file", async () => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacySource));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(BASE_FIXTURE_SHA256);
    expect(LEGACY_STORAGE_KEY).toBe(STORAGE_KEY);
  });

  it("GAP: marker at 'intent' does NOT stop the old writer (it writes the legacy key); the new side can only detect it", async () => {
    const c = await reach("intent");
    expect(localStorage.getItem(CUTOVER_MARKER_KEY)).not.toBeNull();
    const result = await legacySaveProjectsLocked(project("written-by-old-bundle-after-intent"), undefined, LEGACY_RAW);
    expect(result.ok).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toContain("written-by-old-bundle-after-intent");
    const state = c.inspect();
    expect(state.mode).toBe("indeterminate");
  });

  it("GAP: marker at 'committed' does NOT stop the old writer either; legacy archive drifts and is reported indeterminate", async () => {
    const c = await reach("committed");
    const result = await legacySaveProjectsLocked(project("written-by-old-bundle-after-commit"), undefined, LEGACY_RAW);
    expect(result.ok).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toContain("written-by-old-bundle-after-commit");
    expect(c.inspect().mode).toBe("indeterminate");
  });

  it("MITIGATION (simulated lock only): while a host holds the exclusive lock, the old writer is refused with lock-timeout and storage is unchanged", async () => {
    await reach("intent");
    vi.useFakeTimers();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const holder = navigator.locks.request(STORAGE_LOCK_NAME, { mode: "exclusive" }, () => hold);
    const attempt = legacySaveProjectsLocked(project("blocked-while-lock-held"), undefined, LEGACY_RAW);
    await vi.advanceTimersByTimeAsync(8001);
    const result = await attempt;
    expect(result).toMatchObject({ ok: false, reason: "lock-timeout" });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(LEGACY_RAW);
    release(); await holder;
  });

  it("LIMIT: when the lock holder disappears (tab crash/close), the old writer succeeds again — the lock is not a durable fence", async () => {
    await reach("intent");
    vi.useFakeTimers();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const holder = navigator.locks.request(STORAGE_LOCK_NAME, { mode: "exclusive" }, () => hold);
    release(); await holder; // holder gone
    const result = await legacySaveProjectsLocked(project("written-after-holder-vanished"), undefined, LEGACY_RAW);
    expect(result.ok).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toContain("written-after-holder-vanished");
  });
});
