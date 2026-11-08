# P1 — isolated IndexedDB CAS spike

Date: 2026-11-08

## Scope and branch

- PR: https://github.com/Fadhel-docom/DevMate/pull/38
- Branch: `feature/p1-indexeddb-cas-spike`
- Base: `feature/phase-1-foundation` at `3c60a8529ae99d869c3c98970c2df9ff37895d42`
- Initial isolated-spike head: `e06370551d373fabb20948bb6557f97b57373f90`

## Implementation added

- `src/casStore/indexedDbCasStore.ts`: isolated database `devmate-cas-spike-v1`; versioned workspace record; CAS comparison and write inside one IndexedDB readwrite transaction; pre-write backup in the same transaction; strict durability requested; fail-closed error mapping; backup limit of 20 with no automatic eviction.
- `e2e/cas-store-harness/index.html`: isolated two-tab real-Chromium harness. It runs 100 same-baseline races without Web Locks, verifies one success and one conflict per trial, and checks atomic rollback at the backup-persistence boundary. `run-chromium.mjs` drives it headlessly through CDP.

## Safety boundaries

- The module is not imported by the application.
- It never reads or writes localStorage.
- No real user data, migration, cutover, UI wiring, provider integration, or S3 work.
- R1 remains unresolved. S2-16 remains FAIL; this spike does not rewrite or downgrade prior results.

## Verification

- GitHub Actions run `42484007481` on exact head `e06370551d373fabb20948bb6557f97b57373f90`: **success**.
- Workflow includes `npm ci`, dependency audit reporting, `npm test`, and `npm run build`.
- Follow-up real-Chromium proof on head `3f5acda522112db4dc5a8b5fa6be41fae09678b0`: run `42485223078` **success**; full environment and assertions are recorded in `P1-CHROMIUM-REMEDIATION.md`.
- Not tested here: SIGKILL durability, quota exhaustion, restore races, migration, 3+ tabs, other browsers, or mobile.

## How to run the browser spike

1. Check out this branch and run `npm ci`.
2. Start Vite with `npm run dev -- --host 127.0.0.1`.
3. Open `/e2e/cas-store-harness/` in Chromium and allow the popup.
4. Keep both tabs open until the first tab prints its final PASS/FAIL line.
5. Preserve the full output and environment versions with the review evidence.

The harness clears only its own test-backup rows between iterations to avoid exhausting its deliberate 20-backup safety cap. It does not alter the workspace version between races except through the two competing CAS writes.


## Follow-up verification work

See [P1-CHROMIUM-REMEDIATION.md](./P1-CHROMIUM-REMEDIATION.md) for the added backup-write fault-injection assertion, bounded two-tab worker waits, and automated real-Chromium runner. Those checks must pass on the final PR head before merge.
