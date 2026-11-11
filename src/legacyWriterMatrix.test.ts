import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CUTOVER_MARKER_KEY, CUTOVER_SOURCE_COPY_PREFIX, createCutoverController, fingerprintSource, parseMarker, readCutoverState,
  type CutoverStages
} from "./cutoverController";
import {
  BACKUP_KEY, STORAGE_KEY,
  deleteBackup as currentDeleteBackup, restoreBackup as currentRestoreBackup, saveProjects as currentSaveProjects
} from "./storage";
import * as legacy from "./__fixtures__/legacyStorage.base";
import legacySource from "./__fixtures__/legacyStorage.base.ts?raw";
import appSource from "./App.tsx?raw";
import backupManagerSource from "./BackupManager.tsx?raw";
import mainSource from "./main.tsx?raw";
import storageSource from "./storage.ts?raw";

/**
 * R1 matrix (stage S1b). Every mutator below is the REAL, unmodified pre-barrier code (base revision 3c60a85
 * storage.ts, byte-checked by hash) executed against the REAL current controller. Nothing here edits the storage
 * map to imitate an old tab. navigator.locks is a spec-shaped in-memory fake (jsdom has no Web Locks), so lock
 * behaviour is simulated; real-Chromium evidence is in e2e/s1-legacy-writer and is not run in CI.
 *
 * What the matrix establishes: the intent/committed marker does not stop ANY pre-barrier mutator; the new side can
 * only detect some of their effects afterwards, and one of them (deleteBackup) is not detected at all. No guarantee
 * of quiescence can be derived from anything inside the application, so cutover stays closed.
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
const project = (name: string) => [{ id: "p1", name, tasks: [] }];
const LEGACY_RAW = JSON.stringify(project("original"));
const OTHER_RAW = JSON.stringify(project("older-backup-content"));
const copyKey = (raw: string) => `${CUTOVER_SOURCE_COPY_PREFIX}${fingerprintSource(raw)}`;

let originalLocks: PropertyDescriptor | undefined;
beforeEach(() => {
  localStorage.clear();
  originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { value: new FakeLockManager(), configurable: true });
  localStorage.setItem(STORAGE_KEY, LEGACY_RAW);
});
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks); else delete (navigator as unknown as Record<string, unknown>).locks;
});

/** Real controller, real shared lock (fake lock manager). The quiescence callback is test-only; it proves nothing. */
function controller(stages: CutoverStages = okStages) {
  return createCutoverController({ storage: localStorage, stages, confirmLegacyWritersQuiesced: () => true });
}
async function reach(phase: "intent" | "committed", c = controller()) {
  const plan = c.preflight(); if (!plan.ok) throw new Error("preflight failed");
  expect((await c.begin(plan.plan)).ok).toBe(true);
  if (phase === "committed") { expect((await c.resume()).ok).toBe(true); expect(readCutoverState(localStorage).mode).toBe("durable"); }
  return c;
}
const markerPhase = () => { const parsed = parseMarker(localStorage.getItem(CUTOVER_MARKER_KEY) ?? ""); if (!parsed.ok) throw new Error("bad marker"); return parsed.marker.phase; };

/** Each entry runs one real pre-barrier mutator. `detected` = the new side can see the effect through the legacy bytes. */
const OLD_WRITERS: Array<{ name: string; prepare?: () => void; run: () => Promise<{ ok: boolean }>; detected: boolean }> = [
  { name: "saveProjects (unlocked)", detected: true, run: async () => legacy.saveProjects(project("old-saveProjects"), localStorage, LEGACY_RAW) },
  { name: "saveProjectsLocked", detected: true, run: () => legacy.saveProjectsLocked(project("old-saveProjectsLocked"), localStorage, LEGACY_RAW) },
  {
    name: "restoreBackup", detected: true,
    prepare: () => { localStorage.setItem(BACKUP_KEY, OTHER_RAW); },
    run: () => legacy.restoreBackup(BACKUP_KEY, localStorage)
  },
  {
    name: "deleteBackup", detected: false,
    prepare: () => { localStorage.setItem(BACKUP_KEY, OTHER_RAW); },
    run: () => legacy.deleteBackup(BACKUP_KEY, localStorage)
  }
];

describe("R1 matrix — fixture integrity", () => {
  it("the legacy fixture is the unmodified base-revision file", async () => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacySource));
    expect(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")).toBe(BASE_FIXTURE_SHA256);
    expect(legacySource).not.toContain("devmate-cutover-v1");
    expect(legacy.STORAGE_KEY).toBe(STORAGE_KEY);
  });
});

describe.each(["intent", "committed"] as const)("R1 matrix — real pre-barrier writers after '%s'", (phase) => {
  for (const writer of OLD_WRITERS) {
    it(`GAP: ${writer.name} is NOT blocked by the marker; ${writer.detected ? "the new side detects the changed legacy bytes" : "the effect is NOT detected"}`, async () => {
      writer.prepare?.();
      const c = await reach(phase);
      const markerBefore = localStorage.getItem(CUTOVER_MARKER_KEY);
      const result = await writer.run();
      expect(result.ok).toBe(true); // the old code ran to completion despite a valid marker
      expect(localStorage.getItem(CUTOVER_MARKER_KEY)).toBe(markerBefore);
      if (writer.detected) {
        expect(localStorage.getItem(STORAGE_KEY)).not.toBe(LEGACY_RAW);
        expect(c.inspect()).toMatchObject({ mode: "indeterminate", reason: "source-changed" });
        const refused = await c.advance();
        expect(refused).toMatchObject({ ok: false, reason: "source-changed", divergentPreserved: true });
        expect(markerPhase()).toBe(phase); // never advanced, never downgraded
        expect(localStorage.getItem(copyKey(LEGACY_RAW))).toBe(LEGACY_RAW); // original preserved copy untouched
        expect(localStorage.getItem(copyKey(localStorage.getItem(STORAGE_KEY) as string))).toBe(localStorage.getItem(STORAGE_KEY));
      } else {
        // Legacy bytes are unchanged, so every source check still passes while the legacy backup slot is gone.
        expect(localStorage.getItem(STORAGE_KEY)).toBe(LEGACY_RAW);
        expect(localStorage.getItem(BACKUP_KEY)).toBeNull();
        expect(c.inspect().mode).toBe(phase === "intent" ? "recovery" : "durable");
      }
    });
  }
});

describe("R1 matrix — current bundle contrast", () => {
  it("the current barrier refuses all three current mutators once a marker exists (new bundle only)", async () => {
    localStorage.setItem(BACKUP_KEY, OTHER_RAW);
    await reach("intent");
    expect(currentSaveProjects(project("new-bundle-write"), localStorage, LEGACY_RAW)).toMatchObject({ ok: false, reason: "cutover-active" });
    expect(await currentRestoreBackup(BACKUP_KEY, localStorage)).toMatchObject({ ok: false, reason: "cutover-active" });
    expect(await currentDeleteBackup(BACKUP_KEY, localStorage)).toMatchObject({ ok: false, reason: "cutover-active" });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(LEGACY_RAW);
    expect(localStorage.getItem(BACKUP_KEY)).toBe(OTHER_RAW);
  });
});

describe("R1 matrix — timing and concurrency", () => {
  it("a pre-barrier write between preflight and begin aborts the stale plan and writes no marker", async () => {
    const c = controller();
    const plan = c.preflight(); if (!plan.ok) throw new Error("preflight failed");
    expect((await legacy.saveProjectsLocked(project("old-write-before-intent"), localStorage, LEGACY_RAW)).ok).toBe(true);
    expect(await c.begin(plan.plan)).toMatchObject({ ok: false, reason: "stale-plan" });
    expect(localStorage.getItem(CUTOVER_MARKER_KEY)).toBeNull();
  });

  it("an old locked writer queued behind the controller's lock is serialized, not prevented: it lands after the advance and is detected next", async () => {
    const c = await reach("intent");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = controller({ ...okStages, migrateProfiles: async () => { await gate; return { ok: true }; } });
    const advancing = slow.advance(); // holds the shared lock while the stage waits
    const queued = legacy.saveProjectsLocked(project("old-write-queued-behind-controller"), localStorage, LEGACY_RAW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(LEGACY_RAW); // blocked while the controller holds the lock
    release();
    expect(await advancing).toMatchObject({ ok: true, changed: true });
    expect(markerPhase()).toBe("profiles-verified");
    expect((await queued).ok).toBe(true); // the old writer then succeeds
    expect(c.inspect()).toMatchObject({ mode: "indeterminate", reason: "source-changed" });
    expect(await c.advance()).toMatchObject({ ok: false, reason: "source-changed", divergentPreserved: true });
    expect(markerPhase()).toBe("profiles-verified");
  });

  it("an unlocked old write (another process, not subject to the lock) during a stage stops the advance", async () => {
    const c = await reach("intent");
    const racing = controller({
      ...okStages,
      migrateProfiles: async () => { legacy.saveProjects(project("old-unlocked-write-mid-stage"), localStorage, LEGACY_RAW); return { ok: true }; }
    });
    expect(await racing.advance()).toMatchObject({ ok: false, reason: "source-changed", divergentPreserved: true });
    expect(markerPhase()).toBe("intent");
    expect(c.inspect()).toMatchObject({ mode: "indeterminate", reason: "source-changed" });
  });

  it("restart: a fresh controller reaches the same indeterminate verdict, never downgrades, and keeps both copies", async () => {
    await reach("committed");
    expect((await legacy.saveProjectsLocked(project("old-write-after-commit-then-restart"), localStorage, LEGACY_RAW)).ok).toBe(true);
    const written = localStorage.getItem(STORAGE_KEY) as string;
    const restarted = controller(); // simulates a reload: no in-memory state carried over
    expect(restarted.inspect()).toMatchObject({ mode: "indeterminate", reason: "source-changed" });
    expect(await restarted.resume()).toMatchObject({ ok: false, reason: "source-changed" });
    expect(markerPhase()).toBe("committed");
    expect(localStorage.getItem(copyKey(LEGACY_RAW))).toBe(LEGACY_RAW);
    expect(localStorage.getItem(copyKey(written))).toBe(written);
    expect(restarted.exportPreservedSource()).toMatchObject({ ok: true, raw: LEGACY_RAW });
  });

  it("detection is by bytes only: restoring the exact original bytes hides an earlier old write (documented limit)", async () => {
    const c = await reach("intent");
    expect((await legacy.saveProjectsLocked(project("temporary-old-write"), localStorage, LEGACY_RAW)).ok).toBe(true);
    expect(c.inspect().mode).toBe("indeterminate");
    localStorage.setItem(STORAGE_KEY, LEGACY_RAW);
    expect(c.inspect().mode).toBe("recovery");
  });
});

describe("R1 matrix — the quiescence verifier cannot be satisfied implicitly", () => {
  it("only the boolean true opens the gate; truthy look-alikes and a missing verifier do not", async () => {
    for (const verifier of [undefined, () => "true", () => 1, () => ({}), () => undefined, () => null, async () => "yes"] as unknown[]) {
      localStorage.clear(); localStorage.setItem(STORAGE_KEY, LEGACY_RAW);
      const c = createCutoverController({ storage: localStorage, stages: okStages, confirmLegacyWritersQuiesced: verifier as () => boolean });
      const plan = c.preflight(); if (!plan.ok) throw new Error("preflight failed");
      expect(await c.begin(plan.plan)).toMatchObject({ ok: false, reason: "legacy-writers-not-quiesced" });
      expect(localStorage.getItem(CUTOVER_MARKER_KEY)).toBeNull();
      expect(localStorage.getItem(copyKey(LEGACY_RAW))).toBeNull();
    }
  });

  it("no application source wires a verifier; wiring one must be a deliberate, reviewed change", () => {
    for (const source of [appSource, backupManagerSource, mainSource, storageSource]) expect(source).not.toContain("confirmLegacyWritersQuiesced");
  });
});
