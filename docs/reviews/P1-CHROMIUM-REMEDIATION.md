# P1 IndexedDB CAS — atomicity, concurrency and real-Chromium verification

Date: 2026-11-08

## Scope

This change remains an isolated P1 experiment. It does not import the CAS module into the application, read or write localStorage, migrate user data, perform cutover or S3 work, or resolve R1. R1 remains **open**. S2-16 remains **FAIL / open**; this spike does not rewrite or downgrade that record.

## Review remediation status

| Item | Status | Evidence |
| --- | --- | --- |
| B1 — run IDs wrongly attributed to `c038fea` | Fixed | `c038fea` runs are DevMate CI `42485394375` and Chromium proof `42485398569` (both report `head_sha=c038fea…` via the Actions API). Runs `42485219245` / `42485223078` belong to `3f5acda`, not `c038fea`. |
| F7 — Chromium workflow tested the wrong commit | Fixed | `p1-chromium.yml` checks out `${{ github.event.pull_request.head.sha \|\| github.sha }}` and asserts `git rev-parse HEAD` equals that value. Run `42487368360` printed `TESTED_SHA` = `EXPECTED_SHA` = `137a8edf…`. |
| B2a — atomicity test could pass with a non-atomic implementation | Fixed, proven in CI on `137a8ed` | See "Atomicity proof". |
| B2b — two-tab race did not prove contention | Fixed for the single-winner property; symmetric ordering **NOT PROVEN** | See "Concurrency proof". |
| F3–F6 | Reviewed, classified below | See "Findings F3–F6". |

## Atomicity proof (B2a)

Fault injection wraps `IDBObjectStore.prototype.add/put` for the duration of one write. It watches the `records.put()` request and aborts the transaction from that request's `success` event: after the workspace write was executed inside the transaction and before the transaction could complete. After the abort, one shared oracle asserts:

1. `injectionReached` — the `put` success event fired exactly once and the abort was issued.
2. `backupAddExecutedBeforeAbort` — `backups.add()` had already succeeded when the abort happened (so a non-atomic implementation would have a persisted backup to expose).
3. `writeFailed` — the write result is `ok:false`, not a conflict, and nothing was thrown.
4. `errorIsTxAborted` — classified as `tx-aborted`.
5. `versionUnchanged` — workspace version equals the baseline.
6. `rawUnchanged` — workspace raw payload is identical to the baseline.
7. `backupCountZero` — the backup store is empty.

This is a transaction-rollback fault injection. It is not a simulation of disk or quota exhaustion.

### Negative control: split-transaction mutant

`splitMutantWrite` is defined inside the harness. It commits the backup in one transaction and then writes the workspace in a second transaction. It is run through the same oracle with the same injection. The check `ATOMICITY-MUTANT-SPLIT` **fails the harness** if the oracle accepts the mutant, and also fails it if the mutant is rejected for any reason other than "backup stayed committed while the workspace write was aborted" (`backupCountZero:false` with every other assertion true).

## Concurrency proof (B2b)

> **Historical — superseded on 2026-11-08.** This section records the original `window.open` architecture, in which both racers ran on one shared main thread, so the "two-tab race" executed sequentially. Its wording about the 250 ms lead and the 10 s result wait is kept as diagnostic history only and is no longer accurate; its evidence (e.g. `parent=100 worker=0`) is not evidence of concurrent execution. The current design, evidence and limits are in the later Dedicated Worker sections of this file.

Per trial, the parent tab and the second tab (`?worker=1`, opened with `window.open`) run a rendezvous over `BroadcastChannel`:

1. Parent sends `prepare` (trial id, `expectedVersion`, worker payload); the second tab answers `worker-ready` (5 s timeout).
2. Parent sends `parent-ready`, then `go` with a shared wall-clock `startAt` (250 ms ahead to allow BroadcastChannel delivery — **superseded: this explanation was wrong, see "Root cause of the PR #39 barrier failures; Dedicated Worker racers" below**); the second tab refuses to start unless it saw `prepare` and `parent-ready` for the same trial (otherwise it reports `protocolViolation`).
3. Both tabs spin until `startAt` (no timers, no Web Locks) and then write with the same `expectedVersion`. Result wait: 10 s timeout *(historical; superseded: the current implementation waits 5 s for each racer READY and 15 s for each racer result)*.

Per-trial assertions (`evaluateRaceTrial`): barrier proven (both READY timestamps ≤ GO ≤ `startAt` ≤ each side's start); exactly one success; the other side returns a conflict with `actualVersion === expectedVersion + 1`; final version is `expectedVersion + 1`; stored raw equals the winner's payload; exactly one backup, equal to the previous raw with `sourceVersion === expectedVersion` (so a conflict attempt created no extra backup). Each trial logs the winner and both outcomes.

Result on `137a8ed` (Chromium run `42487368360`): 100/100 trials valid, barrier proven 100/100, no violations.

**Limitation (observed, NOT PROVEN otherwise):** the winners were `parent=100 worker=0`. The single-winner/CAS property held, but the ordering in which the second tab's transaction commits first was never exercised. Symmetric contention is therefore not proven. Transaction overlap was reported as informational only (`overlap=true` 100/100, derived from wall-clock timestamps, not asserted).

### Negative control: read-then-write mutant

`mutantReadThenWrite` reads the workspace, posts `mutant-read`, waits at a barrier until the other tab has also read the same baseline, then writes in a separate transaction with no CAS check. Five trials run through the same `evaluateRaceTrial` oracle. The check `RACE-MUTANT` fails the harness unless **every** trial shows `double-success` and `lost-update` with the barrier proven. Observed: 5/5 trials produced two successful writers, `final=v(base+1)` and two backups.

## Automated browser runner

`e2e/cas-store-harness/run-chromium.mjs` launches headless Chromium with a fresh `--user-data-dir` and `--remote-debugging-port=0`, reads the OS-assigned port from `DevToolsActivePort`, and drives the page over the Chrome DevTools Protocol using Node's built-in WebSocket. It prints the Chromium, Node, OS and CDP versions. It attaches to the harness page and to the second tab as soon as Chromium lists it, and fails immediately on `Runtime.exceptionThrown` or `Log.entryAdded` at error level from either. It also requires all seven named checks (`ATOMICITY-REAL`, `ATOMICITY-MUTANT-SPLIT`, `RACE-REAL`, `RACE-MUTANT`, `BACKUP-LIMIT`, `ERRCLASS-REQUEST-ERROR`, `VERSIONCHANGE-FAIL-CLOSED`) to have passed, so a silently skipped check fails the run. *(Superseded 2026-11-08: the runner now requires eight checks; `THREADS-INDEPENDENT` was added.)* The overall deadline defaults to 240 s but the loop exits as soon as a problem or a final status appears.

Terminology: the "worker tab" is a second **browser tab**, not a Web Worker. No dedicated Worker, SharedWorker or Service Worker is used by the harness, and none is monitored. *(Superseded 2026-11-08: the race actors are now Dedicated Workers (`racer.js`). Their uncaught errors are monitored by the worker's own `error`/`unhandledrejection` listeners and by the hosting page; see "Dedicated Worker exception negative control" below. SharedWorker and Service Worker are still not used or monitored.)*

Runner self-test (in CI): `?selftest=page-exception` and `?selftest=worker-exception` inject an uncaught exception in the parent tab and in the second tab. CI requires the runner to fail, within 45 s, with the injected `SELFTEST` message. Observed on `137a8ed`: failure after 2 s and 3 s; the second-tab case was reported with the `?worker=1` tab label.

## CI workflow

`.github/workflows/p1-chromium.yml`: `pull_request` on `feature/**` and `push` on `fix/**`; `permissions: contents: read` only; `runs-on: ubuntu-24.04`; checkout of `github.event.pull_request.head.sha || github.sha` with `persist-credentials: false`; exact-SHA assertion; `npm ci`; Playwright 1.56.1 used only to download Chromium; `npm run build` (which runs `tsc --noEmit && vite build`); Vite harness server; real-browser harness; runner self-test.

`ci.yml` (DevMate CI, outside this PR's changes) has no `permissions` block and uses `ubuntu-latest`, which resolved to `ubuntu-26.04` in the run below; this is noted as a follow-up and was not changed here.

## Findings F3–F6

| Id | Classification | Severity | Action |
| --- | --- | --- | --- |
| F3 — backup limit 20, no pruning | **Proven behavior** (`BACKUP-LIMIT`): 20 writes succeed; write 21 returns `backup-limit` and leaves the workspace unchanged. Once 20 backups exist, every later write fails until backups are removed. Not a defect of the spike; a retention-policy decision. | Medium if this design were adopted beyond the spike; none for the spike | No pruning added, retention policy unchanged. Out of scope: pruning/eviction policy. |
| F4 — error classification and `tx.error` | **Handled in the current store and covered by a test**: the store reads `tx.error` in `onerror`/`onabort`; a failing request is not masked as `tx-aborted` (`ERRCLASS-REQUEST-ERROR` forces a `ConstraintError` on `backups.add()` and expects `unknown`, workspace unchanged). Not mapped: `ConstraintError`, `DataError`, `InvalidStateError`, `VersionError` all return `unknown` (fail-closed). A `QuotaExceededError` at commit would map to `quota` through `tx.onabort`; **not tested** (real quota exhaustion not reproduced). | Low | None further. |
| F5 — `onblocked`, `onversionchange`, timeouts, lifecycle | `onversionchange` closes the connection and later operations fail closed without throwing or writing (`VERSIONCHANGE-FAIL-CLOSED`, proven); after that the store instance stays unusable (no reopen) and the error is `unknown`. `onblocked` on upgrade is **theoretical**: unreachable with `CAS_DB_VERSION = 1`, not tested. Read/write operations have no timeout: a stalled transaction would leave the promise pending; **theoretical, not tested**. | Low (versionchange); Low–Medium theoretical (no operation timeout) | No change; documented. |
| F6 — runner: exceptions, worker target, timeout, port, profile | Page and second-tab uncaught exceptions and error-level `Log` entries fail fast (proven by the two self-tests). Fresh profile and OS-assigned port are in the code and the port is printed. **Gaps (theoretical):** Web Workers are neither used nor monitored *(superseded 2026-11-08: the race actors are Dedicated Workers whose errors are monitored by `racer.js` and covered by `selftest=racer-exception`)*; `console.error()` calls from page scripts (`Runtime.consoleAPICalled`) are not treated as failures (the harness makes none); an exception thrown in the second tab before the runner attaches to it relies on the in-page forwarding to the parent. `--no-sandbox` is used because the runner is CI-only. | Low | No change; documented. |

## Execution evidence

Code-bearing head, exact SHA `137a8edf6a54263cd314251af06e4ff2a64ed638`:

- DevMate CI run `42487363856` — **success**: `npm ci`, dependency audit report (0 vulnerabilities), `npm test` (9 files, 216 tests passed), `npm run build` (`tsc --noEmit` and `vite build`). Runner image `ubuntu-latest` = Ubuntu 26.04, Node 20.20.2. https://github.com/Fadhel-docom/DevMate/actions/runs/42487363856
- Real-Chromium proof run `42487368360` — **success**: https://github.com/Fadhel-docom/DevMate/actions/runs/42487368360
  - Runner image: `ubuntu-24.04` (Ubuntu 24.04.5 LTS), Node v22.23.4, Linux x64.
  - Browser: Chromium 141.0.7390.37 (Playwright build v1194); CDP product Chrome/141.0.7390.37.
  - `ALL-CHECKS PASS: passed=7 failed=none`.
  - `ATOMICITY-REAL` PASS; `ATOMICITY-MUTANT-SPLIT` PASS (mutant rejected, backups=1 left behind); `RACE-REAL` PASS (100/100, winners parent=100 worker=0); `RACE-MUTANT` PASS (5/5 detected); `BACKUP-LIMIT`, `ERRCLASS-REQUEST-ERROR`, `VERSIONCHANGE-FAIL-CLOSED` PASS.
  - Runner self-tests: page-exception and worker-exception (second tab) both failed the runner as intended (2 s and 3 s).

Earlier verified heads: `c038fea5dcbfe43a54f0327153b6ea2b11d4e3f3` (CI `42485394375`, Chromium `42485398569`); `749405281175ed107143de279380cbf3390eba84` (CI `42485495472`, Chromium `42485499657`). Both predate the B2 harness rework and are historical.

Any commit after `137a8ed`, including documentation-only commits, needs fresh CI and Chromium runs whose `head_sha` equals the new PR head. The final PR head and its run IDs are recorded in the PR #38 description, not in this file (a commit cannot contain its own SHA).

## What was and was not tested

Tested (in CI, real Chromium 141 on Linux x64): transaction rollback at `records.put()` success; split-transaction mutant rejection; 100 two-tab same-baseline races with a per-trial READY/GO rendezvous; read-then-write mutant rejection (5/5); backup cap behavior; request-error classification; fail-closed behavior after `versionchange`; runner failure on uncaught page and second-tab exceptions.

**Not tested / NOT PROVEN:** symmetric race ordering (the second tab never won); a local run outside CI (verification relied on the CI runs above); SIGKILL durability; real quota exhaustion; restore races; migration; 3+ tabs; mobile; Firefox/Safari; `onblocked` on upgrade; read/write operation timeouts; Web Worker exception monitoring *(superseded 2026-11-08 for the parent-tab racer worker: covered by `selftest=racer-exception`; the second-tab racer worker's error path is not separately exercised)*.

## Merge gate

R1 and S2-16 remain open. This PR stays Draft and is not merge-ready until an independent evidence-based review of the final SHA approves it.

## Follow-up hardening on PR #39 branch — 2026-11-08

This section supersedes the earlier concurrency-barrier wording above for the updated harness.

- The second tab's `goReceivedAt` is now returned with its result and must be no later than the shared `startAt`; READY timestamps and the parent GO send time are also checked.
- Each real/mutant trial uses an explicit 0 ms / 12 ms role offset, alternating which tab is released first. This is controlled winner-order coverage, not a claim of simultaneous transaction overlap.
- The real race check now requires both parent and second-tab wins to occur across the 100 trials. A run that exercises only one winner identity fails.
- Transaction overlap remains informational and is not used as proof. The test reports measured winner counts, delays, GO receipt time, start skew, and overlap.
- This hardening has been committed on the follow-up branch; no new CI result is claimed until the exact PR head completes both workflows.

### First exact-head run after the ordering change — timing defect found

- Chromium run `42493035962` on head `4c09632eb800a6270fe3bd3ed335c79787b8480c` failed in `RACE-REAL` and `RACE-MUTANT`; the other five checks passed.
- The log showed the worker's `goReceivedAt` was later than the 30 ms `startAt` lead, so the new receipt-time assertion correctly rejected the barrier. Three of five mutant trials were consequently not eligible as valid negative-control detections.
- Corrected the shared lead to 250 ms. This is a harness scheduling allowance, not a claim about IndexedDB performance. The updated exact head must pass a fresh Chromium run before review. **Superseded: the 250 ms lead did not fix the failure and was never its cause; see "Root cause of the PR #39 barrier failures; Dedicated Worker racers" below.**

## Root cause of the PR #39 barrier failures; Dedicated Worker racers — 2026-11-08

This section supersedes the earlier statements that the 250 ms GO lead "allows BroadcastChannel delivery" and that both tabs raced in parallel. The 250 ms lead did not fix the failure and was never the cause.

### Hypothesis tested: a main-thread spin in one tab blocks the other tab
Raised as unproven; tested in Chromium 141 / Ubuntu 24.04 (CI run `42503135265`, job `128799987716`, head `1352ba05e663ee06652b77420f0af4e1412432b2`, diagnostics only, assertions unchanged):
- Parent main-thread spin of 150 ms: the second tab (`window.open`) received the probe only after the spin ended in 8/8 probes (delivery latency 150 ms each).
- Second-tab main-thread spin of 150 ms: the parent's 4 ms timer showed gaps of 150-151 ms in 6/6 probes (idle control: 4 ms).
- Old protocol, 12 real trials: `goReceivedAt - startAt` equalled the parent's own release delay every time (12 ms when the parent was delayed 12 ms, 0 ms otherwise), the two write starts coincided when the parent was delayed (`writeStartDeltaMs=0`), and the parent won 12/12. GO is delivered only after the parent's spin ends, so no GO lead can fix it; the original `startedAt >= startAt` assertion could not see it.
- Second tab opened with `noopener`: the parent's spin did not delay it (0/8 probes delayed, 0 ms latency). The reverse probe was inconclusive (parent timers were throttled to 1000 ms even in the idle control). `noopener` was not adopted because it relies on Chromium's process-allocation policy, which is not guaranteed.

Conclusion: the hypothesis is confirmed for the `window.open` tab architecture. The two tabs share one main thread, so the "two-tab race" executed the two main-thread operations sequentially. Both the 30 ms failure and the 250 ms failure have this one cause. The merged PR #38 harness has the same architecture; its race results are not evidence of simultaneous main-thread execution (not re-run on PR #38's SHA).

### Fix
- Race actors moved to `e2e/cas-store-harness/racer.js`, one Dedicated Worker hosted by each tab. The spin loop and the CAS write run in the worker; page main threads never spin during a trial.
- New required check `THREADS-INDEPENDENT` (listed in the runner's required checks): while one racer spins 150 ms the other must receive a probe during the spin, 10 probes in each direction; it fails if any probe is received less than 20 ms before the spin ends.
- The per-trial barrier is proven, not assumed: both racers READY before GO, both received GO no later than the shared `startAt`, and neither wrote before its release time. `goReceivedAt - startAt` and every timestamp are logged per trial.
- Release plan: parent-first (0/12 ms), worker-first (12/0 ms), simultaneous (0/0 ms), repeating. Controlled offsets give ordering coverage only; they are not claimed as concurrency.

### Result on head `d082c88d40803b010aa54a35b1072085ff509e43` (Chromium job `128801325263`, run `42503581222`; DevMate CI run `42503576163`)
- All 8 checks passed, including `THREADS-INDEPENDENT` 20/20 (margins 147-150 ms before spin end).
- `RACE-REAL` 100/100 valid: `goReceivedAt - startAt` between -250 and -247 ms in every trial; wins parent=45, second tab=55. By plan: parent-first 25/0, worker-first 0/25, simultaneous 20/30.
- `RACE-MUTANT` 5/5 rejected with the barrier proven (double-success, lost-update, backup-count=2); no trial was counted because of a failed barrier.
- Atomicity (real and split mutant), backup limit, error classification and versionchange checks passed.
- The final head differs from `d082c88` only by a trace label and documentation; its own run is recorded in the PR description.

### Not proven
- Transaction-level overlap inside IndexedDB. "overlap" in the log compares the racers' operation intervals (including waiting for the IDB callback); it is informational.
- Genuine contention beyond the 50 simultaneous trials; controlled-offset trials show CAS correctness under a forced order only.
- Cross-process behaviour (workers prove independent threads, not independent processes), 3+ tabs, other browsers or OSes, runner CPU count (not logged), repeatability beyond one CI run.
- Nothing here changes R1 or S2-16: both remain open and the application storage path is untouched.

## Dedicated Worker exception negative control — `selftest=racer-exception` (2026-11-08)

Closes reviewer follow-up F5 (no negative control for uncaught Dedicated Worker errors).

### Mechanism
- `index.html` (`?selftest=racer-exception`) starts one real racer worker (`racer.js`, `name: "parent"`), waits for its `racer-up`, then broadcasts `racer-selftest-throw`. `racer.js` handles that message by throwing `new Error("SELFTEST racer uncaught exception")` from a timer, so the error is uncaught inside the actual Dedicated Worker. The message is only ever sent in this self-test.
- The only path that can end this run is the worker's own monitor: `self.addEventListener("error")` in `racer.js` broadcasts `racer-exception`, and the parent page turns it into `setStatus("fail", "racer parent: uncaught: …")`. The host-side `Worker` `error` event is cancelled and merely logged in this mode, and the page has no pass path (`await new Promise(() => {})`), so neither the host listener nor a timeout can produce the expected failure.
- CI (`p1-chromium.yml`, runner self-test step) runs the mode next to `page-exception` and `worker-exception` and requires all of: the runner exits non-zero; the log contains the injected `SELFTEST` text; the log contains `Chromium harness failed: racer parent: uncaught: … SELFTEST racer uncaught exception`; the log does not contain `did not finish within` or `timeout after`; elapsed time is under 20 s.
- No `src/` file and no existing required check was changed.

### Limits
- Only the parent-tab racer (`role: "parent"`) is made to throw. The second-tab racer runs the same `racer.js` listener but its error path is not separately exercised.
- It proves the monitor reports an uncaught error and that the runner fails for that reason; it does not prove that every kind of worker failure (e.g. a worker that dies silently or never reports) is detected. A racer that stalls is still bounded only by the per-trial 5 s / 15 s waits.
- SharedWorker and Service Worker are not used or monitored.
- Exact-head CI and Chromium evidence for this change is recorded in the PR #39 description, not here (a commit cannot contain its own SHA). R1 and S2-16 remain open.
