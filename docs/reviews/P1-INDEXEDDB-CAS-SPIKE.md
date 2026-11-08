# P1 — isolated IndexedDB CAS spike

Date: 2026-11-08

## Scope and branch

- PR: https://github.com/Fadhel-docom/DevMate/pull/38
- Branch: `feature/p1-indexeddb-cas-spike`
- Base: `feature/phase-1-foundation` at `3c60a8529ae99d869c3c98970c2df9ff37895d42`
- Initial isolated-spike head: `e06370551d373fabb20948bb6557f97b57373f90`

## Implementation added

- `src/casStore/indexedDbCasStore.ts`: isolated database `devmate-cas-spike-v1`; versioned workspace record; CAS comparison and write inside one IndexedDB readwrite transaction; pre-write backup in the same transaction; strict durability requested; fail-closed error mapping that reads `tx.error`; backup limit of 20 with no automatic eviction; `onversionchange` closes the connection.
- `e2e/cas-store-harness/index.html`: isolated two-tab real-Chromium harness with seven named checks: atomicity (fault injection at `records.put()` success) with a split-transaction negative control; 100 same-baseline races with a per-trial READY/GO rendezvous and a read-then-write negative control; backup-limit behavior; request-error classification; fail-closed behavior after `versionchange`. No Web Locks.
- `e2e/cas-store-harness/run-chromium.mjs`: headless Chromium driven over CDP; fails on uncaught exceptions in the harness page or the second tab, requires all seven checks to have passed, and uses a fresh profile and an OS-assigned debugging port.

## Safety boundaries

- The module is not imported by the application.
- It never reads or writes localStorage.
- No real user data, migration, cutover, UI wiring, provider integration, or S3 work.
- R1 remains open. S2-16 remains FAIL; this spike does not rewrite or downgrade prior results.

## Verification

- Method, negative controls, findings F3–F6, environment and exact-head evidence are recorded in [P1-CHROMIUM-REMEDIATION.md](./P1-CHROMIUM-REMEDIATION.md).
- Code-bearing head `137a8edf6a54263cd314251af06e4ff2a64ed638`: DevMate CI run `42487363856` success; real-Chromium proof run `42487368360` success (Chromium 141.0.7390.37, Ubuntu 24.04.5 LTS, Node v22.23.4).
- Both mutants were detected and rejected: the split-transaction mutant (atomicity) and the read-then-write mutant (5/5 race trials).
- The final PR head and its run IDs are in the PR #38 description.
- Not tested: symmetric race ordering (the second tab never won a trial), SIGKILL durability, real quota exhaustion, restore races, migration, 3+ tabs, other browsers, mobile, `onblocked` on upgrade, operation timeouts.

## How to run the browser spike

Automated (as in CI):

1. `npm ci`
2. Install Chromium: `npx --yes playwright@1.56.1 install --with-deps chromium`
3. Start Vite: `npm run dev -- --host 127.0.0.1 --port 4173`
4. Set `CHROMIUM_BIN` to the downloaded `chrome` executable and run `DEVMATE_TEST_URL=http://127.0.0.1:4173 node e2e/cas-store-harness/run-chromium.mjs`

Manual: open `/e2e/cas-store-harness/` in Chromium, allow the popup, and keep both tabs open until the first tab prints its final `ALL-CHECKS` line.

The harness clears only its own test-backup rows between checks to avoid exhausting its deliberate 20-backup cap, and deletes `devmate-cas-spike-v1` at the end of a passing run.
