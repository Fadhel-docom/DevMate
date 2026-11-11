// Current (post-barrier) production code, bundled unmodified and exposed to a real browser page as window.cur.
// Nothing here re-implements production logic; helpers only call the real exported functions.
import {
  CUTOVER_MARKER_KEY, CUTOVER_SOURCE_COPY_PREFIX, createCutoverController, createCutoverStages, fingerprintSource, parseMarker, readCutoverState,
  type CutoverStages
} from "../../src/cutoverController";
import * as storage from "../../src/storage";

export { CUTOVER_MARKER_KEY, CUTOVER_SOURCE_COPY_PREFIX, createCutoverController, createCutoverStages, fingerprintSource, parseMarker, readCutoverState, storage };

/** Test-only quiescence callback: lets the lifecycle run. It is NOT evidence that any legacy writer stopped. */
export const makeController = (overrides: Record<string, unknown> = {}) =>
  createCutoverController({ storage: localStorage, stages: createCutoverStages(), confirmLegacyWritersQuiesced: () => true, ...overrides } as never);

export const markerPhase = (): string | null => {
  const raw = localStorage.getItem(CUTOVER_MARKER_KEY);
  if (raw === null) return null;
  const parsed = parseMarker(raw);
  return parsed.ok ? parsed.marker.phase : "malformed";
};

/** Real preflight + begin + advance() calls, real production stages unless `stages` is overridden. */
export async function driveTo(phase: "intent" | "profiles-verified" | "stores-verified" | "committed", overrides: Record<string, unknown> = {}) {
  const c = makeController(overrides);
  const plan = c.preflight();
  if (!plan.ok) return { ok: false as const, step: "preflight", detail: plan };
  const begun = await c.begin(plan.plan);
  if (!begun.ok) return { ok: false as const, step: "begin", detail: begun };
  for (let guard = 0; guard < 6 && markerPhase() !== phase; guard++) {
    const advanced = await c.advance();
    if (!advanced.ok) return { ok: false as const, step: "advance", detail: advanced };
  }
  return { ok: true as const, phase: markerPhase() };
}

export const dumpStorage = (): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) as string; out[k] = localStorage.getItem(k); }
  return out;
};

/** Quota helpers: they only call the real localStorage; no production code is replaced. */
export const Q = {
  capacity(): number { // largest value length (for key "__p") that the real quota still accepts
    let lo = 0, hi = 12_000_000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      try { localStorage.setItem("__p", "x".repeat(mid)); lo = mid; } catch { hi = mid - 1; }
    }
    try { localStorage.removeItem("__p"); } catch { /* ignore */ }
    return lo;
  },
  fillFull(): number {
    for (const size of [200_000, 20_000, 2_000, 200, 20, 1]) {
      for (let i = 0; ; i++) {
        try { localStorage.setItem(`__fill:${size}:${i}`, "x".repeat(size)); } catch { break; }
      }
    }
    return Q.capacity();
  },
  /** After fillFull(): free exactly `target` value characters by shrinking one filler key. Returns measured capacity. */
  setCapacity(target: number): number {
    let c = Q.capacity();
    const key = "__fill:200000:0";
    for (let attempt = 0; attempt < 4 && c !== target; attempt++) {
      const current = (localStorage.getItem(key) ?? "").length;
      const next = Math.max(0, current - (target - c));
      try { localStorage.setItem(key, "x".repeat(next)); } catch { /* growing back failed; capacity measured below */ }
      c = Q.capacity();
    }
    return c;
  },
  needFor: (key: string, value: string): number => key.length + value.length - "__p".length,
  clearFill(): void { for (const k of Object.keys(dumpStorage())) if (k.startsWith("__fill")) localStorage.removeItem(k); }
};

export type { CutoverStages };
