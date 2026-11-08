# S2 real-browser persistence evidence (R6)

`run.mjs` bundles the current cutover controller with esbuild (already a Vite dependency), serves it from `http://localhost:47831` and drives real Chromium with real `localStorage`, real Web Locks and a real persistent profile directory.

Scenarios: (A) two tabs racing `begin()` and `resume()`; (B) browser close/reopen after every marker phase and a malformed marker; (C) real storage-quota exhaustion at the raw-copy write, at the marker write, and at a phase advance (boundary found by byte); (D) storage unavailable (opaque-origin sandbox).

Playwright is **not** a repository dependency and nothing here runs in CI. To reproduce: install `playwright@1.49.1` and its Chromium outside the repo, make Chromium launchable (Debian: libnss3, libnspr4, libdbus-1-3, libatk1.0-0t64, libatk-bridge2.0-0t64, libatspi2.0-0t64, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libgbm1, libdrm2, libxkbcommon0, libasound2t64), link it into `node_modules`, then run `node e2e/s2-browser-persistence/run.mjs` from the repo root after `npm ci`.

The stage callbacks are test doubles (counters), and the quiescence callback is test-only `true`; neither is evidence about production stages or about any legacy writer. The pre-barrier-writer question (R1) is covered by `e2e/s1-legacy-writer`, not here.
