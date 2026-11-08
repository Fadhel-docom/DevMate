# S2 — real-Chromium persistence tests (PR-D cutover controller)

Test-only harness. It bundles the **unmodified** production TypeScript (`src/cutoverController.ts`, `src/storage.ts`) and the hash-checked base-revision legacy writer (`src/__fixtures__/legacyStorage.base.ts`) with esbuild and runs them in **real Chromium** through Playwright. No jsdom, no fake Web Locks, no fake storage.

Run: `node e2e/s2-browser-persistence/run.mjs [S2-01 S2-02 ...]` (no arguments = all 15 scenarios, about 4 minutes). Add `--out=<file>` to write a filtered run into a named results file next to the harness (used for `results.addendum-1.json`). Exit code 1 if any scenario FAILs or ERRORs; a scenario that could not exercise what it claims is reported as `NOT TESTED` (never PASS). A full run writes `results.json`; a filtered run writes `out/results.partial.json` (git-ignored).

Requirements (NOT repository dependencies; nothing was added to package.json): Node, `playwright` with a Chromium build, `esbuild`. `results.json -> meta` records the exact versions, OS, the PR #33 head SHA and the empty `src/` diff against it.

Fault injection is used in exactly one scenario (S2-08, marker read/write faults) at the `Storage.prototype` boundary, because Chromium cannot be made to fail one specific key. Everything else uses real failures: genuine localStorage quota (S2-06), a sandboxed opaque-origin iframe that really throws SecurityError (S2-07), SIGKILL of a persistent-profile browser (S2-10), real Web Locks inspected with `navigator.locks.query()`.

FAIL results are findings, not harness errors; see `docs/reviews/S2-CHROMIUM-REPORT.md`.

`results.json` is the full 15-scenario run made at commit `2632eec` and is kept unchanged as history. `results.addendum-1.json` holds the later filtered run (S2-15 reclassified, S2-16 added) and records its own harness commit SHA.
