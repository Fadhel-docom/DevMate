# S1 real-browser evidence (R1)

`run.mjs` bundles (esbuild, already a Vite dependency) the unmodified base-revision `storage.ts` writer (`window.legacy`) and the current controller (`window.current`), serves them from `http://localhost`, and drives two real Chromium tabs sharing one `localStorage` and real Web Locks.

Playwright is **not** a repository dependency and nothing here runs in CI. To reproduce: install `playwright` outside the repo, make Chromium launchable, then `node e2e/s1-legacy-writer/run.mjs` from the repo root after `npm ci`.

The quiescence callback is test-only `true`; it is not evidence that any legacy writer stopped. The lock-hold scenario is a separate mitigation experiment, not a fix for R1.
