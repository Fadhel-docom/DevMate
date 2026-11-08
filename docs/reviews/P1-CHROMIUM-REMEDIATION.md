# P1 IndexedDB CAS — atomicity and real-Chromium verification

Date: 2026-11-08

## Scope

This change remains an isolated P1 experiment. It does not import the CAS module into the application, read or write localStorage, migrate user data, perform cutover, or resolve R1.

## New proof: backup-write failure is atomic

The browser harness injects a synchronous `QuotaExceededError` specifically when the `backups` object store receives `add()`. It then verifies all of the following:

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

## Evidence status

- Backup-failure atomicity assertion: added; execution pending CI.
- 100 two-tab Chromium races: automated; execution pending CI.
- Browser/OS/Node versions: emitted by the runner at execution.
- SIGKILL durability, physical quota exhaustion, restore races, 3+ tabs, mobile, and non-Chromium browsers: not tested by this P1 spike.
- R1 remains unresolved. S2-16 remains FAIL.
- This PR is not merge-ready until exact-head CI and an independent evidence-based review pass.
