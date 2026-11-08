# P1 IndexedDB CAS — atomicity and real-Chromium verification

Date: 2026-11-08

## Scope

This change remains an isolated P1 experiment. It does not import the CAS module into the application, read or write localStorage, migrate user data, perform cutover, or resolve R1.

## New proof: backup-write failure is atomic

The browser harness intercepts the backup-store `add()`, queues the backup request, then aborts the encompassing readwrite transaction from the backup request's success event before the queued workspace write can commit. It then verifies both object stores roll back together:

1. The injection was reached.
2. The attempted CAS write does not report success.
3. The workspace version is unchanged.
4. The workspace raw payload is byte-for-byte unchanged.
5. The backup store remains empty.

This is a fault-injection test of transaction rollback, not a simulation of physical disk exhaustion. A separate real quota-exhaustion test remains outstanding.

## Real two-tab Chromium race proof

The harness runs 100 same-baseline races between two independent browser tabs using BroadcastChannel. It asserts one successful writer, one version conflict, and exactly one version increment per trial. Each worker response has a 10-second timeout; a missing worker response fails the run instead of hanging indefinitely.

The harness does not use Web Locks. The test database is isolated under `devmate-cas-spike-v1`.

## Automated browser runner

`e2e/cas-store-harness/run-chromium.mjs` launches headless Chromium and uses the Chrome DevTools Protocol through Node's built-in WebSocket implementation. No Playwright test dependency is added to the application. The workflow downloads a pinned Playwright Chromium build solely as the browser binary.

The runner prints:
- Chromium executable version
- CDP browser product/version
- Node version, OS platform, and architecture
- Complete harness output and final exit status

## CI workflow

`.github/workflows/p1-chromium.yml` installs Chromium, builds the project, starts the Vite harness server, and runs the real-browser checks. It runs on pushes to `fix/**` and pull requests targeting `feature/**`.

## Local reproduction

1. Run `npm ci`.
2. Install Chromium with `npx --yes playwright@1.56.1 install --with-deps chromium`.
3. Start Vite: `npm run dev -- --host 127.0.0.1 --port 4173`.
4. Find the downloaded executable with:
   `find "$HOME/.cache/ms-playwright" -type f -path '*/chrome-linux*/chrome' -perm -u+x | head -n 1`
5. Set `CHROMIUM_BIN` to that executable and run:
   `DEVMATE_TEST_URL=http://127.0.0.1:4173 node e2e/cas-store-harness/run-chromium.mjs`

## Execution evidence

The first clean Chromium run was on exact PR head `3f5acda522112db4dc5a8b5fa6be41fae09678b0`. After the error-classification assertion was added, the latest code verification ran on exact head `c038fea5dcbfe43a54f0327153b6ea2b11d4e3f3`:

- DevMate CI: run `42485219245` — **success** (npm ci, tests, TypeScript check, build).
- Real-Chromium proof: run `42485223078` — **success**.
- Runner image: Ubuntu 24.04.5 LTS (`ubuntu-24.04`).
- Browser executable: Chromium 141.0.7390.37; CDP product: Chrome/141.0.7390.37.
- Runtime: Node v22.23.4, Linux x64.
- Backup transaction-abort assertion: **PASS** — write returned `tx-aborted`; workspace version stayed 1; raw payload was unchanged; backup count stayed 0.
- Two-tab race: **PASS** — 100 successes, 100 conflicts, zero double-success, zero double-failure, zero wrong-version outcomes.
- Runner also checks for uncaught runtime exceptions; none were reported in this successful run.

## Earlier runner corrections

- The first workflow attempt used Ubuntu 26.04, which Playwright 1.56.1 did not support; the workflow was pinned to Ubuntu 24.04.
- An intermediate Chromium run passed the data assertions but surfaced an uncaught `TransactionInactiveError` from the fault injector. The injector was changed to abort from the backup request's success event, and the runner now fails on uncaught page exceptions. The final run above passed cleanly.

## Remaining untested boundaries

- This fault injection verifies atomic rollback at the backup-persistence boundary; it is not a physical disk-quota exhaustion simulation.
- SIGKILL durability, real quota exhaustion, restore races, 3+ tabs, mobile, and non-Chromium browsers remain untested.
- R1 remains unresolved. S2-16 remains FAIL.
- The c038fea runs verify the latest code-bearing commit; the later 749405 runs
verify the exact PR head after documentation-only changes. Any subsequent
commit, including a documentation-only commit, requires fresh CI and Chromium
runs whose `head_sha` equals the new PR head. The PR is not merge-ready until
an independent evidence-based review of the final SHA approves it.

## Review remediation status

- B1 (incorrect run IDs attributed to c038fea): corrected above. The c038fea
  run IDs are 42485394375 and 42485398569; 42485219245 and 42485223078 are not
  evidence for that commit.
- B2 (negative controls and deterministic transaction interleaving): still
  open. The current harness does not yet prove it rejects a deliberately
  split backup/workspace implementation, nor does its message ordering force
  both writers to contend at the transaction boundary.
