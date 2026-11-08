# PR-D implementation and review ledger

**Purpose:** Preserve each implementation/review stage as an independently auditable checkpoint. A later stage must not overwrite the evidence or verdict of an earlier stage.

## Operating rules

- Scope is limited to PR #32 in this repository and its branch `feature/pr-d-cutover-intent-barrier`.
- Each stage records: scope, exact base/head SHA, changed files, tests and their environment, CI run tied to the exact SHA, reviewer and review type, findings, disposition, and remaining risks.
- A stage is **implemented** only when code and tests are present; **verified** only when the recorded evidence is independently checked; **reviewed** only when a reviewer has inspected that exact SHA; **closed** only when findings are resolved or explicitly accepted within authority.
- A new commit invalidates exact-head CI and review evidence for the new head unless the reviewer explicitly confirms the change is documentation-only and does not affect the reviewed code. No silent carry-forward.
- One reviewer should review one bounded stage at a time. Record a separate verdict for every stage; do not collapse multiple stages into one vague approval.
- Reviews posted through the owner's GitHub account must be labelled coordinator/self-account COMMENT, not represented as an independent GitHub APPROVE. Seek a genuinely separate reviewer/model for independent review.
- No merge until the full PR-D gate is satisfied. No live migration/cutover, deletion, deployment, provider integration, cost, permission expansion, main-branch change, or RateNest work.

## Global checkpoint — 2026-11-07

- Repository: `Fadhel-docom/DevMate`
- PR: [#32](https://github.com/Fadhel-docom/DevMate/pull/32)
- Branch: `feature/pr-d-cutover-intent-barrier`
- Base: `feature/phase-1-foundation`
- Live head at checkpoint: `269e0a8daf3c504070cf411e7353a1c32af62771`
- PR state: open, ready for review, mergeable=true, not merged.
- Changed files: `docs/DURABLE-STORAGE.md`, `docs/OPERATIONS-ROOM.md`, `docs/PR-D-RECOVERY-DESIGN.md`, `docs/STATUS.md`, `src/App.test.tsx`, `src/App.tsx`, `src/BackupManager.tsx`, `src/cutoverController.test.ts`, `src/cutoverController.ts`, `src/storage.test.ts`, `src/storage.ts`.
- Latest commit at checkpoint: `269e0a8` — test-only lock-runner injection for quiescence-gate tests.
- Reviews currently recorded: three COMMENT reviews on older heads (`68207a4`, `1fd2769`, `5fbe33d`). None approves the live head. The first found the stale pre-barrier writer issue; later comments correctly state R1 remains partial.
- Current exact-head CI lookup through the connected GitHub Actions interface returned no PR-triggered runs and no combined statuses for `269e0a8`. This is **not proof of failure or proof of success**; verify the actual Actions page/run and checkout SHA before relying on CI.
- The implementer's last reported local baseline: 314 tests, typecheck/build clean, audit 0. This was reported by Claude, not independently reproduced in this checkpoint.
- Chromium launched headless in Playwright per Claude's environment report. No new code was changed in that report; browser launch alone is not a browser regression test.

## Stage register

| Stage | Scope | Status at checkpoint | Required exit evidence |
|---|---|---|---|
| S0 | Baseline, live PR and evidence reconciliation | Recorded; CI evidence discrepancy open | Exact live SHA, full CI run/job logs, clean install/test/typecheck/build/audit |
| S1 | R1 stale-version / stale-tab writer protection | **Open / partial** | Real host-level version fence; every legacy mutator protected; tests run pre-barrier writer path; close/crash/suspend/BFCache/reconnect and pending-write browser tests; prove no unsafe successful verifier |
| S2 | R6 browser persistence safety | Open | Chromium two-tab contention, browser quota, reload/restart at each phase, marker read/write failures; logs and exact test commands |
| S3 | Recovery and archive UX | Open | Read-only legacy task archive/export path, recovery states, accessible/mobile controls, no false success, tests |
| S4 | R4 abort eligibility and R5 snapshot-full boundary | Partly defined in design | Auditable eligibility report and raw export; no in-app marker deletion/pruning; owner-only destructive path remains outside implementation |
| S5 | Project isolation, CAS, failure/retry matrix | Open | Cross-project isolation and conflict/retry/crash injection tests, no cross-project writes |
| S6 | Final documentation and independent review | Open | STATUS/OPERATIONS/this ledger reconciled; each stage separately reviewed; final reviewer examines exact final SHA and all unresolved risks |

## Stage S0 — Baseline and reconciliation

**Checkpoint SHA:** `269e0a8daf3c504070cf411e7353a1c32af62771`

### Findings
1. PR description still describes an older verification state; it must be reconciled only after current CI evidence is retrieved.
2. The three existing review submissions are COMMENT-only and attached to older SHAs; they are not approval of this live head.
3. Claude's report confirms dependencies installed and Chromium could launch, but says no repository modifications had yet been made in that session.
4. Current R1 design remains fail-closed by default. Do not enable production `confirmLegacyWritersQuiesced` based on a test callback.
5. Existing R6 browser requirements remain unimplemented.

### Verdict
**S0 recorded; not closed.** Exact-head CI and local baseline need independently verifiable evidence.

## Review record template (duplicate for each stage)

- Stage:
- Reviewer / model:
- Review type: independent / coordinator / implementation self-check
- Exact head SHA:
- Files and scope inspected:
- Tests independently run:
- Findings: blocking / non-blocking / none
- Required fixes:
- Fix commit SHA(s):
- Re-review SHA and verdict:
- Residual risks:
- Stage disposition: open / verified / reviewed / closed

## Handoff rule

After completing a stage, append a dated immutable record below before moving to the next stage. Do not rewrite an earlier verdict; add a superseding record with the new SHA and explain why.


## Stage S0 — verification addendum (2026-11-07)

- Verification head: `0837ae3aaab46528d3041711df15f049bd4ef1b8` (same implementation tree as `269e0a8`; subsequent commits in this checkpoint only add the review ledger and links to it).
- Actions run: [#42407412736](https://github.com/Fadhel-docom/DevMate/actions/runs/42407412736), event `push`, completed / success, exact checkout SHA verified in the job log.
- Job `verify`: all steps passed — checkout, Node setup, `npm ci`, dependency audit report, `npm test`, `npm run build`.
- `npm ci`: 155 packages installed, 156 audited, 0 vulnerabilities.
- Tests: 10 test files, 314 tests passed.
- Build: `tsc --noEmit` passed; Vite 6.4.5 production build passed.
- Environment warning: GitHub runner reports Node 20 deprecation for checkout/setup-node actions; this did not fail the job and is a maintenance follow-up, not a PR-D correctness result.
- Reviewer: no independent reviewer has reviewed SHA `0837ae3`; prior COMMENT reviews target older SHAs.
- Verdict: **S0 CI verified on 0837ae3; S0 independent review still open.** No CI evidence is carried forward to a later code head without a new exact-head run.


## Stage S1 — R1 pre-barrier writer evidence, record 1 (2026-11-07)

- **Parent / base of this record:** `8742c3e20b8175b6ded1e82b3db4a994ece31907` (live PR head verified through the GitHub API immediately before work; PR #32 open, unmerged). The SHA of the commit that carries this record is appended in record 2 below once the commit exists.
- **Scope of the change:** test evidence only. No production code changed; `confirmLegacyWritersQuiesced` is still not supplied by the app, so cutover still cannot be started by default.
- **Files added:** `src/__fixtures__/legacyStorage.base.ts` (byte-for-byte copy of `src/storage.ts` at base revision `3c60a8529ae99d869c3c98970c2df9ff37895d42`, git blob `819997449e653e53aab7e5aec934093c1d44ee06`, sha256 `91ffc4cd07135d62933da4e742e9e57eb38159f47d2746f5c71f4814b69bc5f4`, guarded by a hash test), `src/legacyWriterFence.test.ts`, `src/raw.d.ts` (typing for the `?raw` import only).
- **Environment:** Composio remote sandbox, Node v24.22.1, npm 10.9.2 installed in a user directory (no global install), jsdom. Dependencies from `npm ci`. No Chromium was used for this record.
- **Commands run (local, exact tree of this commit before pushing):** `node node_modules/vitest/vitest.mjs run` → 11 files, 319 tests passed (314 baseline + 5 new); `node node_modules/typescript/bin/tsc --noEmit` → no errors.
- **What the tests do:** run the **unmodified base-revision writer** (`saveProjectsLocked`, the only write path the base `App.tsx` uses) against the same `localStorage` as the current controller. `navigator.locks` is a spec-shaped in-memory **fake** (exclusive, FIFO, abort on queued requests). The quiescence callback is test-only `true` and is not evidence that any writer stopped.
- **Observed results:**
  1. After the controller reaches `intent`, the old writer **succeeds** in overwriting the legacy workspace; the controller then reports `indeterminate` (source changed). The marker does not prevent the write.
  2. After `committed`, the old writer **also succeeds**; the controller reports `indeterminate`. Same conclusion.
  3. While a host holds the exclusive lock, the old writer is refused with `lock-timeout` and storage is unchanged (fake lock only).
  4. When the holder disappears, the old writer succeeds again. A held lock is not a durable fence.
- **Not proven:** any behaviour of a real browser or real Web Locks; close/crash/suspend/BFCache/reconnect; a pending write across a deployment; any production quiescence verifier.
- **Findings:** the marker plus post-hoc revalidation can only **detect** legacy writes by pre-barrier bundles; it cannot **prevent** them. A cooperative lock held for the whole cutover window would block base-revision writers only while the holder lives, and Web Locks alone is not accepted as proof of quiescence.
- **Candidate directions (not implemented, owner/reviewer decision may be needed):** (a) hold the storage lock for the full intent→committed window as a mitigation, with the controller refactored to avoid re-entrant lock requests; (b) narrow the supported guarantee: post-commit legacy drift is detected and preserved, and cutover is gated on an operational procedure that closes old tabs.
- **CI:** not yet run for the commit carrying this record (see record 2).
- **Review:** none. No independent reviewer has seen this stage.
- **Verdict:** **R1 UNRESOLVED.** S1 status: **Open** (evidence implemented locally; not CI-verified; not reviewed).


## Stage S1 — R1 pre-barrier writer evidence, record 2 (2026-11-07)

- **Evidence commit:** [`427f1668f1dec4fd1b1defdd56d55518d1a9b303`](https://github.com/Fadhel-docom/DevMate/commit/427f1668f1dec4fd1b1defdd56d55518d1a9b303) (parent `8742c3e20b8175b6ded1e82b3db4a994ece31907`), carrying record 1 and the test files.
- **CI on that exact SHA:** [run 42409531559](https://github.com/Fadhel-docom/DevMate/actions/runs/42409531559), event `push`, completed / success. Job `verify` (id 128514438014) reports `head_sha` `427f166…`; steps checkout, setup-node, `npm ci`, dependency audit report, `npm test`, `npm run build` all succeeded. The job log shows 11 test files and 319 tests passed, and the Vite build completed.
- **Verdict (supersedes nothing in record 1; adds CI evidence):** evidence is CI-verified on `427f166`. **R1 remains UNRESOLVED.** S1 status: **Open** — an independent review of this exact SHA has not happened; no production fence exists; real-browser confirmation is pending (S2).
- This record's own commit is documentation-only; exact-head CI for it is recorded separately if it differs.

## Stage S1 — R1, record 3: review package, real-browser evidence, review request (2026-11-07)

- **Evidence SHAs and CI (exact-head):** `427f166` → [run 42409531559](https://github.com/Fadhel-docom/DevMate/actions/runs/42409531559) success; `27590f8` (docs) → [run 42409630164](https://github.com/Fadhel-docom/DevMate/actions/runs/42409630164) success; `e215c39` (docs) → [run 42409825338](https://github.com/Fadhel-docom/DevMate/actions/runs/42409825338) success; `22f3fcc` (real-browser harness + results) → [run 42410871238](https://github.com/Fadhel-docom/DevMate/actions/runs/42410871238) success (`npm ci`, `npm test`, `npm run build` passed).
- **Review target:** `22f3fccf69cdaa0d1dd075f6015c167caeb9280a`. Package: `docs/reviews/S1-REVIEW-PACKAGE.md`. This record's commit is documentation-only.
- **New evidence (real Chromium 131, two tabs, real Web Locks; harness `e2e/s1-legacy-writer/run.mjs`, results `results.json`):** old writer succeeded 5/5 after `intent` and 5/5 after `committed`; controller reported `indeterminate` afterwards. Cross-tab reads lagged briefly (8/10 trials stale immediately after the write, settled within 2 ms). Separate mitigation experiment: with a live lock holder the old writer got `lock-timeout` after ~8005 ms and nothing changed; after the holder tab closed, the old writer succeeded. Lock holding is **not** adopted as a solution and is not claimed to prevent old writers.
- **Not tested:** crash/hang, BFCache, suspend, reconnect, pending write across a deployment, host-level version gate, other browsers/mobile.
- **Reviewer / review type:** none. Independent review requested in [PR comment](https://github.com/Fadhel-docom/DevMate/pull/32#issuecomment-6712583754) (a request, not an approval). No independent reviewer has been obtained; absence is recorded as **not approved**.
- **Technical conclusion:** nothing in this repository can force an already-loaded pre-barrier bundle to stop writing; the marker detects, it does not prevent.
- **Residual risks:** see the package (post-commit overwrite by old tabs, unbounded detection window, lock loss on holder death, no crash/BFCache coverage).
- **Verdict:** **R1 UNRESOLVED. S1: Open** (evidence implemented and CI-verified; independent review pending; no fence).


## Stage S1 — R1, record 4: real-writer matrix and impossibility finding (2026-11-08)

- **Scope:** independent re-examination of the code at PR #32 head `a853f2af71383fb863171533e05588f54a86c86b` (CI `verify` success on that SHA), not of earlier reports. Read in full: `src/storage.ts`, `src/cutoverController.ts`, the legacy fixture, `src/legacyWriterFence.test.ts`, `e2e/s1-legacy-writer/*`.
- **Added:** `src/legacyWriterMatrix.test.ts` (17 tests). It executes the real, hash-checked pre-barrier `saveProjects`, `saveProjectsLocked`, `restoreBackup` and `deleteBackup` against the real controller after `intent` and after `committed`; plus stale plan before intent, an old writer queued behind the controller lock, an unlocked old write during a stage, restart, and verifier-contract tests. No test edits the storage map to imitate an old tab. Mutation checks: dropping the post-stage source revalidation, or accepting truthy verifier values, each fails a test.
- **Findings:** (1) the marker blocks none of the four old mutators; (2) three are detected after the fact, never prevented; (3) **old `deleteBackup` is undetected** and can delete legacy backup slots after `intent`/`committed`; (4) detection is byte-based (ABA hides a restored original); (5) the lock serializes an old locked writer behind the controller but does not stop it afterwards.
- **No change to production code.** `begin()` already fails closed and the app supplies no verifier; a guard test now fails if an application source file wires one.
- **Verdict:** no real guarantee is possible with the current constraints (see `docs/PR-D-RECOVERY-DESIGN.md` section 11.1). **R1 remains UNRESOLVED. Cutover remains closed.** Residual risks: post-commit overwrite by old tabs, undetected legacy-backup deletion, unbounded detection window, lock loss on holder death, crash/BFCache/suspend untested, other browsers untested.
- Exact-head CI for the commit carrying this record is recorded in the PR description of the work PR, not here.


## Stage S1 — review addendum and Stage S2 — real-Chromium record 1 (2026-11-08)

- **Code under test:** PR #33 head `752445ced37d8dcf2bb35402de543812f0e0e3b9` (PR #32 head `a853f2af71383fb863171533e05588f54a86c86b`, both still open, unmerged when checked). `src/` byte-identical to the PR #33 head. PR #33 CI: [run 42454182359](https://github.com/Fadhel-docom/DevMate/actions/runs/42454182359) (336 tests). This record's own commit is test-tooling and documentation only.
- **S1 review (independent re-read, appended; nothing above changed):** the fixture `src/__fixtures__/legacyStorage.base.ts` is byte-identical to base `src/storage.ts` @3c60a85 (blob `819997449e653e53aab7e5aec934093c1d44ee06`); `saveProjects`, `saveProjectsLocked`, `restoreBackup`, `deleteBackup` in the matrix are the real legacy mutators; the conclusions (marker detects, never prevents; old `deleteBackup` undetected) are supported. **Gaps in the matrix:** G1 the legacy read path (`readProjects`/`readProjectsLocked`) also writes backup slots and is not covered by jsdom tests; G2 `restoreBackup`/`deleteBackup` are called without the UI's fingerprint argument; G3 no test that a stale cross-tab read can double-declare intent; G4 no real lock/real storage behaviour in jsdom; G5 no timing coverage for a write queued behind the lock. G1–G5 are covered in real Chromium by S2-02, S2-12, S2-13, S2-14.
- **S2 (real Chromium 153.0.8010.12, Playwright 1.63.0, Linux 6.18.44, Node v22.23.4; harness `e2e/s2-browser-persistence/`):** 15 scenarios, **13 PASS, 2 FAIL, 64/66 checks**; full per-scenario steps, results and limits in `docs/reviews/S2-CHROMIUM-REPORT.md`, raw data in `e2e/s2-browser-persistence/results.json`.
- **Findings:** (1) S2-02 FAIL: 7/60 races ended with both tabs reporting `changed:true` (state still consistent: one `intent` marker, one copy); (2) S2-04 FAIL: real Web Lock excludes concurrent holders but localStorage read-modify-write across tabs still lost 13–34 of 90 updates (stale cross-tab reads); (3) old autosave succeeds after every phase (20/20) and is detected afterwards; (4) old `deleteBackup` deletes backups at every phase undetected; old load after `intent` writes backup slots undetected; (5) crash: flushed state always survives, never half-written, but writes within ≈4 s before SIGKILL were lost together; (6) quota, blocked storage, marker faults, restarts, cross-tab marker visibility pass.
- **Not tested:** real App UI, BFCache (probe inconclusive), OS crash/power loss, renderer-only crash, other browsers/mobile, local vitest run.
- **Review:** none; this is implementer evidence, not an independent review.
- **Verdict:** **R1 remains UNRESOLVED** (now also shown in real Chromium); **R6** gains two real-browser findings (S2-02/S2-04) for the reviewer. **S2: tests implemented and run in real Chromium with the limits above; stage not closed — awaiting independent review.** S3 not started; cutover remains closed.


## Stage S2 — real-Chromium record 2 (addendum to record 1; record 1 is unchanged) (2026-11-08)

- **Reason:** preliminary review of PR #35 asked for a corrected BFCache classification, an application-level test of lost updates, and reproducibility data. Only S2-15 and the new S2-16 were run; the 15-scenario run in record 1 was not repeated.
- **Code under test:** PR #33 head `752445ced37d8dcf2bb35402de543812f0e0e3b9` (`src/` byte-identical; PR #32 head `a853f2a` and PR #33 unchanged). Harness commit for this run: `dc2983e51dddc468e672637f1167a0dccdf7a26d` (clean tree). Chromium 153.0.8010.12, Playwright 1.63.0, Node v22.23.4, esbuild 0.28.2, Linux 6.18.44. Raw: `e2e/s2-browser-persistence/results.addendum-1.json`. Rerun: `node e2e/s2-browser-persistence/run.mjs S2-15 S2-16 --out=results.addendum-1.json`.
- **S2-15 BFCache: NOT TESTED** (goBack did not restore from BFCache). Supersedes the "PASS" label of record 1 for that scenario; record 1 stays as written. Honest totals of the original run: 12 PASS, 2 FAIL, 1 NOT TESTED.
- **S2-16 (new): FAIL 1/4.** Real `readProjectsLocked`/`saveProjectsLocked` with `expectedRaw`, two real tabs: simultaneous saves from the same verified baseline both reported ok in 15/40 trials with one acknowledged edit missing from the final workspace each time; sustained 2×25 edits lost 1–2 acknowledged edits per run (two runs); the sequential outdated-baseline case correctly reports conflict. Expectations not relaxed.
- **Not tested:** real UI, >2 tabs, other browsers, BFCache, OS crash.
- **Review:** none yet. **Verdict:** R1 UNRESOLVED; S2 not closed; new finding F-S2-16 (silent overwrite in the existing save path, independent of cutover) needs an owner/reviewer decision — nothing was changed.
