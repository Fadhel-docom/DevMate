import { describe, expect, it } from "vitest";

/**
 * R1 narrowing guard. No host-level fence exists against already-loaded pre-barrier bundles, so the mutating
 * cutover controller must not be reachable from the production entry point. This walks the real static import
 * graph from src/main.tsx (the Vite entry referenced by index.html) over the actual source text.
 */
const SOURCES = import.meta.glob("./*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
function resolveImport(spec: string): string | null {
  if (!spec.startsWith("./")) return null;
  for (const candidate of [`${spec}.ts`, `${spec}.tsx`, spec]) if (candidate in SOURCES) return candidate;
  return null;
}
function graph(entry: string): Map<string, string> {
  const seen = new Map<string, string>(); const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue;
    const text = SOURCES[file]; if (text === undefined) throw new Error(`missing source ${file}`);
    seen.set(file, text);
    for (const match of text.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const next = resolveImport(match[1] ?? match[2] ?? match[3] ?? "");
      if (next) queue.push(next);
    }
  }
  return seen;
}
const names = (g: Map<string, string>) => [...g.keys()].map((file) => file.slice(2));

describe("production isolation of the mutating cutover controller (R1 narrowing)", () => {
  const entry = graph("./main.tsx");
  it("walks a non-trivial production graph that includes the read-only state module", () => {
    expect(names(entry)).toEqual(expect.arrayContaining(["main.tsx", "App.tsx", "cutoverState.ts", "RecoveryArchive.tsx", "storage.ts"]));
  });
  it("does not reach cutoverController.ts, the stores it wires, or any marker writer", () => {
    const reached = names(entry);
    expect(reached).not.toContain("cutoverController.ts");
    expect(reached).not.toContain("profileStore.ts");
    expect(reached).not.toContain("taskLedgerStore.ts");
    for (const [file, text] of entry) {
      expect(text, file).not.toMatch(/createCutoverController|createCutoverStages|confirmLegacyWritersQuiesced/);
      expect(text, file).not.toMatch(/setItem\(\s*(?:CUTOVER_MARKER_KEY|CUTOVER_INTENT_KEY)/);
    }
  });
  it("the read-only state and archive modules never call a storage mutator", () => {
    for (const name of ["cutoverState.ts", "archiveExport.ts", "RecoveryArchive.tsx"]) {
      const text = SOURCES[`./${name}`]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(text, name).not.toMatch(/\.(setItem|removeItem|clear)\s*\(/);
    }
  });
  it("the walker itself detects a mutating import (self-test)", () => {
    const withController = graph("./legacyWriterFence.test.ts");
    expect(names(withController)).toContain("cutoverController.ts");
  });
});
