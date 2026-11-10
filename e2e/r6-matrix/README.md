# R6 real-Chromium matrix (PR-D repair)

Real-browser evidence for DevMate PR #32. **Not part of `npm test`, not run by GitHub Actions, and Playwright is not a dependency of the app.**
This directory has its own `package.json` (Playwright 1.49.1, pinned) so the root dependency tree and lockfile are untouched.

## Run

```
npm ci                                   # repo root
cd e2e/r6-matrix && npm ci && npx playwright install chromium && cd ../..
node e2e/r6-matrix/run.mjs               # builds dist/, bundles the harness, runs Chromium headless, writes results.json
```
On Linux you may also need Chromium's system libraries (`npx playwright install-deps chromium`, or apt packages libnss3 libatk1.0-0 libgbm1 libasound2 ...).
Exit code 1 means at least one check failed. GitHub Actions runs this suite on every PR head (`.github/workflows/r6-chromium.yml`); the artifact `r6-chromium-results` of that run is the authoritative evidence for that head. The tracked `results.json` is only a dated snapshot (see its `sourceCommit`). `results.json` records the Chromium/Playwright/Node versions, `sourceCommit` and whether the working tree was dirty.

## What is real and what is injected

* Real: Chromium, the built production bundle (`npm run build` output), real `localStorage` and its real quota (`QuotaExceededError` is thrown by the browser), real Web Locks across tabs, real tab kills (`page.close`), real file downloads compared byte for byte.
* Test double: `confirmLegacyWritersQuiesced: () => true`. It lets the harness drive the lifecycle and proves nothing about real writers.
* Fault injection (marked `faultInjected` in `results.json`): C6 wraps `Storage.prototype.getItem/setItem` for the marker key; C9 throws on the Nth `setItem`. The storage underneath is still the real browser storage.

## Cases

| Id | What it shows |
|----|---------------|
| C1 | The built bundle contains no marker writer or controller; legacy editing still works in the built app. |
| C2-* | Built app at every phase: truthful panel, editing locked, read-only task list, keyboard-operable byte-exact download, 360 px layout, reload keeps state, no storage writes. |
| C3 | A pre-barrier writer still succeeds after intent/commit (**documented R1 limitation, not a fix**); the built app then detects the divergence, locks editing and exports both byte sets. Malformed/unreadable marker fails closed. |
| C4 | Two real tabs: exactly one declares intent, one marker write per phase in order, both converge to durable. |
| C5 | Real quota exhaustion before intent and during migration: fail closed, legacy bytes exact, completes after space is freed. |
| C6 | Marker write throws / silently dropped / advance dropped / read throws / Web Locks missing: fail closed, never a false success. |
| C7 | Restart at each phase; 12 tab kills at different moments; the dead tab's lock never blocks recovery. |
| C8 | Real lock held by another tab: bounded `lock-timeout`, nothing written, completes after release. |
| C9 | Failure before/after every one of the clean run's writes (error and quota), restart, retry: always recovers to durable with exact legacy bytes and monotonic phases. |
| C10 | An already-open page reacts to another tab's write (old-writer divergence, or a marker appearing) through real `storage` events, without reload and without writing. |
