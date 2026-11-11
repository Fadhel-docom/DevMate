# New Claude worker handoff — DevMate PR #32 consolidated repair
**Prepared:** 2026-11-09  
**Role:** incoming Claude implementer (you have not worked on this repository/task before)  
**Authoritative coordination hub:** `docs/OPERATIONS-ROOM.md`  
**Repository:** `https://github.com/Fadhel-docom/DevMate`  
**Assigned branch:** `feature/pr-d-cutover-intent-barrier`  
**PR:** #32 — https://github.com/Fadhel-docom/DevMate/pull/32  
**Base branch:** `feature/phase-1-foundation`

## Stop: read the Operations Room first
The Operations Room is the centre of the work, not this handoff and not the owner's chat. Before editing anything, read:
1. `docs/OPERATIONS-ROOM.md` in full enough to identify the newest dated checkpoint and all binding rules.
2. `docs/STATUS.md` for current status and exact next action.
3. `docs/reviews/PR32-CONSOLIDATED-REVIEW-2026-11-09.md` for the single consolidated ChatGPT review and complete acceptance criteria.
4. PR #32 current metadata, comments, diff and checks.
5. Relevant implementation and evidence: `src/cutoverController.ts`, `src/storage.ts`, App integration, controller tests, `docs/PR-D-RECOVERY-DESIGN.md`, `docs/PR-D-REVIEW-LEDGER.md`, `docs/reviews/S1-REVIEW-PACKAGE.md`, and `e2e/s1-legacy-writer/`.

The newest dated Operations Room entry governs. Do not assume this handoff's recorded SHA is still the current head; fetch it. At preparation time the last PR metadata fetch reported head `8010e992faa8f1ea1a7bf0201303568c2d74791f`, PR #32 open and not merged. Earlier review target SHA was `60ec4450f36a9981cdc37d7346b3d12e2d4f8d40`; documentation commits followed.

## Exactly where to work
Work only in:
- Repository: `Fadhel-docom/DevMate`
- Branch: `feature/pr-d-cutover-intent-barrier`
- Pull request: #32

Do not create a replacement branch or PR. Do not touch `main`, any other PR/branch, RateNest or another repository. Do not ask the owner to transfer messages or files. You have the review report and all required context in the repository.

## Your task: one repair pass, all blockers together
ChatGPT completed one consolidated review. Verdict: **REQUEST CHANGES — BLOCKED / NOT ACCEPTED.** You are explicitly authorised to choose the safest technical approach and refactor/redesign the branch as needed. Fix all findings in one consolidated repair pass. This is not permission to weaken safety gates or claim unproven guarantees.

### F1 / R1 — stale pre-barrier writers (critical)
Existing real Chromium evidence showed the unmodified old bundle writer succeeded 5/5 after `intent` and 5/5 after `committed`. A localStorage marker only protects code that checks it; an already-loaded old bundle does not. A lock only blocks while its holder is alive. The current callback/test injection is not proof of production-wide quiescence.

Implement a genuine enforceable host-level stale-client/version fence that prevents old app instances from writing throughout cutover, including after commit, and prove it in real Chromium. If this cannot be safely implemented, redesign the feature so cutover remains disabled and the product capability is honestly narrowed. Never use a checkbox, permissive callback, marker-only check, or tab-held lock as a fake fence.

### F2 / R6 — real-browser persistence and failure matrix
Build and execute a reproducible real-Chromium harness using actual browser storage and Web Locks. Cover two-tab contention/ordering, quota exhaustion, marker read/write/read-back failures, reload/restart at every phase, lock contention/timeouts and interrupted-write recovery. Preserve raw machine-readable results, browser/environment versions and exact commands. Assert fail-closed behaviour, byte preservation, no unintended overwrite/delete and truthful UI state.

### F3 / S3 — usable recovery/archive experience
Implement the minimum safe and accessible recovery flow: distinguish legacy/recovery/durable/indeterminate states; read-only inspection of retained legacy task data; user-operable byte-preserving raw export; clear durable-state UI; truthful failure states. No destructive marker deletion, pruning, release or slot-reset feature.

### F4 / S5 — project isolation and retry safety
Complete the multi-project matrix: isolation, interleaved operations, stale plans, conflicts, partial stage failures, retry and crash/restart boundaries. Prove no cross-project mutation, task loss/duplication, false phase advancement or unsafe retry. Preserve exact raw legacy bytes.

## Freedom and constraints
You may select the architecture, implementation details and test structure. You may refactor production code and add/update tests/docs as needed. Prefer the smallest safe architecture, not the smallest diff. If a requirement is impossible, explain why with evidence and leave the PR blocked. Do not fabricate browser results, CI success or guarantees. Do not introduce destructive operations.

Do not perform real-user-data migration/cutover, deployment, deletion/pruning, marker removal, production release, permission expansion, or any other owner-reserved action. Do not use Google Jules unless the owner explicitly approves it.

## Required delivery — directly into the Operations Room
At completion, update `docs/OPERATIONS-ROOM.md` and `docs/STATUS.md` yourself. Your handoff must include:
- Exact final commit SHA and branch.
- Complete changed-file list and concise reason for each.
- F1, F2, F3, F4: pass/fail/not safely achievable, with exact evidence.
- Exact commands run and exit codes/results.
- Real Chromium version/environment and raw machine-readable browser results.
- GitHub Actions run URL/ID, jobs and logs proving the run checked out the exact final SHA.
- Any remaining limitations and why they are safe.
- Explicit statement whether you believe the PR meets every acceptance gate. Do not merge it; ChatGPT performs final verification and owns merge/closure.

If blocked, record the exact blocker and evidence, keep the feature fail-closed, and mark **BLOCKED / NOT ACCEPTED**. Do not conceal missing evidence.

## Where your work starts and ends
**Start:** after reading the Operations Room and STATUS, re-fetch PR #32 and inspect the current head; then implement all F1–F4 on the assigned branch in one consolidated pass.

**End:** commit the repair, run the required tests, obtain exact-head CI evidence, and write the complete handoff into Operations Room and STATUS. Then stop and wait for ChatGPT's one final exact-SHA verification. Do not merge. If a safe fix is impossible, end with a documented BLOCKED / NOT ACCEPTED handoff.

The owner is not a messenger. All coordination and evidence belong in the Operations Room.
