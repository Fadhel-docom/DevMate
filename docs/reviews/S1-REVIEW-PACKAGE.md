# S1 review package — R1 (stale pre-barrier writers)

**Stage:** S1 only. Do not fold S2–S6 into this verdict.
**Review target (code and test evidence):** `22f3fccf69cdaa0d1dd075f6015c167caeb9280a` on `feature/pr-d-cutover-intent-barrier` (PR #32). Exact-head CI: [run 42410871238](https://github.com/Fadhel-docom/DevMate/actions/runs/42410871238), success (`npm ci`, `npm test`, `npm run build`).
**Later commits:** documentation only (this package and log records). A reviewer should diff `22f3fcc..<head>` to confirm.
**Reviewer:** none yet. Requested in [this PR comment](https://github.com/Fadhel-docom/DevMate/pull/32#issuecomment-6712583754). A coordinator/self-account COMMENT is not an independent review, and the absence of a review is not approval.

## What the reviewer is asked to judge (claims C1–C6)

- **C1.** The unmodified base-revision writer (`saveProjectsLocked`, `3c60a85:src/storage.ts`) successfully overwrites the legacy workspace after the cutover marker reaches `intent`.
- **C2.** The same holds after `committed`.
- **C3.** The marker and the controller's post-hoc revalidation only **detect** such writes (state becomes `indeterminate`); they do not **prevent** them.
- **C4.** No production fence exists. The app does not supply `confirmLegacyWritersQuiesced`, so cutover cannot start by default. Test-only `true` callbacks prove nothing about real writers.
- **C5.** Holding the exclusive storage lock is only a separate mitigation experiment. It is not a guarantee and is not offered as a fix.
- **C6.** R1 is correctly recorded as **unresolved**.

## Evidence

| Evidence | Where | Environment | Result |
|---|---|---|---|
| Old writer vs current controller, fake locks | `src/legacyWriterFence.test.ts`, fixture `src/__fixtures__/legacyStorage.base.ts` (sha256 `91ffc4cd…bc5f4`, git blob `81999744…1d44ee06`, hash-guarded) | vitest + jsdom, spec-shaped **fake** `navigator.locks` | 5 tests pass; full suite 11 files / 319 tests; `tsc --noEmit` clean; CI green |
| Old writer vs current controller, real browser | `e2e/s1-legacy-writer/run.mjs`, recorded `results.json` | Chromium 131.0.6778.33 headless (Playwright 1.49.1, `--no-sandbox`), two tabs, one `localStorage`, real Web Locks on `http://localhost` | see below |

### Real-Chromium results (5 trials per phase; fresh context each)

- After `intent`: old writer succeeded **5/5**; the legacy workspace changed; the controller then reported `indeterminate` (detection).
- After `committed`: old writer succeeded **5/5**; controller reported `indeterminate`.
- Cross-tab visibility: in **8/10** trials a read in the new tab immediately after the old tab's write still returned the previous value; it settled within 2 ms in all 10. (A first manual run showed the same lag once as `durable` because the inspection ran too early.) This is an observation about timing, not a claim about ordering guarantees.
- Separate mitigation experiment, one run: with a live tab holding the exclusive lock, the old writer was refused with `lock-timeout` after ~8005 ms and the legacy bytes were unchanged; after the holder tab was closed, the old writer succeeded again.

The quiescence callback in all of these is test-only `true`; it is not evidence that any legacy writer stopped.

## Limits of the evidence (not tested)

- Only the base-revision writer was exercised, not every historical bundle.
- Not tested: tab crash or hang without clean close, BFCache, suspend/resume, reconnect, a deployment while a write is pending, a service-worker or host-level version gate, other browsers (Firefox, Safari), mobile.
- The lock experiment is a single run in one browser; it shows nothing about fairness, starvation or lock stealing.
- The vitest lock manager is a fake; only the Chromium run uses real locks.

## Technical conclusion (the reasoning, not a tested fact)

Code already running in an open page cannot be changed by a later deployment or by a localStorage marker. The base writer never reads the marker, so from inside this repository there is nothing that forces such a writer to stop; the observed results agree. What the application can honestly offer is detection and preservation of divergence, plus an operational precondition that old tabs are closed before cutover. That precondition cannot be proven from inside the app, so the supported guarantee must be narrowed or the cutover gate must stay closed. Therefore **R1 remains unresolved**; S1 is not closed.

## Residual risks

1. A pre-barrier tab can overwrite the legacy workspace at any time, including after `committed`; the user's edits in that tab may be lost or may diverge from the durable stores.
2. Detection depends on a later read; the window between write and detection is not bounded.
3. A lock held by a live tab is lost if that tab dies.
4. Real-browser coverage of failure modes (crash, BFCache, suspend) is absent (S2).

## Reproduce

- `npm ci && npx vitest run src/legacyWriterFence.test.ts && npx tsc --noEmit`
- Browser run (Playwright is not a repo dependency; install it and a launchable Chromium outside the repo, see `e2e/s1-legacy-writer/README.md`): `node e2e/s1-legacy-writer/run.mjs`

## Requested output

One verdict limited to S1: APPROVE / APPROVE WITH FOLLOW-UP / REQUEST CHANGES, with reviewer identity, review type (independent / coordinator / self-check), the exact SHA reviewed, findings and required fixes.
