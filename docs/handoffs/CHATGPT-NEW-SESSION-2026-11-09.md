# New ChatGPT worker handoff — DevMate PR #32
**Prepared:** 2026-11-09  
**Role:** incoming ChatGPT coordinator and final verifier  
**Authoritative coordination hub:** `docs/OPERATIONS-ROOM.md`  
**Current task branch:** `feature/pr-d-cutover-intent-barrier`  
**PR:** #32 — https://github.com/Fadhel-docom/DevMate/pull/32

## Non-negotiable rule: the Operations Room is the workplace
Do not treat this handoff, a chat, or a PR comment as the source of truth. The Operations Room is the centre of all work. Read `docs/OPERATIONS-ROOM.md` and `docs/STATUS.md` first, then keep both updated directly in the repository. All workers must take instructions from and return evidence to those records. The owner is not a courier and must not be asked to copy/paste between agents.

## Read in this order before doing anything
1. `docs/OPERATIONS-ROOM.md` — read the latest dated checkpoint and binding workflow rules. Older entries are history; the newest dated checkpoint governs.
2. `docs/STATUS.md` — read current state, dependencies, exact next action and blockers.
3. `docs/reviews/PR32-CONSOLIDATED-REVIEW-2026-11-09.md` — the complete one-pass review and acceptance criteria.
4. PR #32 current metadata, full diff, review comments and checks: https://github.com/Fadhel-docom/DevMate/pull/32
5. The relevant implementation/evidence named by the review: `src/cutoverController.ts`, `src/storage.ts`, App integration, controller tests, `docs/PR-D-RECOVERY-DESIGN.md`, `docs/PR-D-REVIEW-LEDGER.md`, `docs/reviews/S1-REVIEW-PACKAGE.md`, and `e2e/s1-legacy-writer/`.

Never assume an old SHA is current. Re-fetch the PR head, base, branch and check runs at session start. Record the exact SHA you actually inspect.

## Where the work starts
Start with **PR #32 only**, on `feature/pr-d-cutover-intent-barrier`, based on `feature/phase-1-foundation`. The consolidated review was authored against head `60ec4450f36a9981cdc37d7346b3d12e2d4f8d40`; subsequent commits updated review/operations documentation. The last PR metadata fetch at preparation time reported PR #32 open, not merged, with head `8010e992faa8f1ea1a7bf0201303568c2d74791f`. Verify this again before action because branch state can move.

The review verdict is **REQUEST CHANGES — BLOCKED / NOT ACCEPTED**. Do not merge now.

## The exact assignment
Claude owns one consolidated repair pass. ChatGPT must not start implementing a competing fix while Claude's repair is pending. The four blockers and acceptance gates are in the consolidated review:
- **F1 / R1:** prevent stale pre-barrier application instances from writing during and after cutover. Existing evidence showed the old writer succeeds after intent and committed; a marker, test callback, or tab-held Web Lock is not a production fence. If a robust fence cannot be proven, keep cutover disabled and clearly narrow the capability; never fake safety.
- **F2 / R6:** complete reproducible real-Chromium tests for real two-tab contention, quota, marker read/write/read-back failures, restart/reload at each phase, locks/timeouts and recovery. Preserve raw results and exact environment.
- **F3 / S3:** deliver a safe, accessible recovery/archive path, read-only legacy task inspection and byte-preserving export; no destructive release/prune controls.
- **F4 / S5:** prove cross-project isolation, interleaving, conflict/retry, crash injection, no data loss/duplication and idempotent recovery.

Claude may refactor or redesign as required. If any requirement cannot be met safely, the work remains BLOCKED / NOT ACCEPTED with precise evidence.

## ChatGPT's responsibility after Claude
Wait for Claude's direct handoff in the Operations Room and STATUS. Do not rely on a chat statement or PR comment alone. Then:
1. Fetch the final branch/PR head and verify the exact final SHA.
2. Inspect every changed file and compare implementation against F1–F4 acceptance criteria.
3. Re-run or independently verify the relevant tests and inspect GitHub Actions logs for a run checking out that exact SHA. Earlier-SHA CI does not count.
4. Verify raw browser evidence, commands, versions, failures and results; distinguish tested facts from claims.
5. Check docs, ledger, PR body, STATUS and Operations Room agree with implementation and evidence.
6. Record the final verdict and all evidence directly in the Operations Room and STATUS.
7. **Only if every gate passes:** merge PR #32, verify GitHub reports merged/closed, record merge commit SHA and post-merge validation. If any blocker remains: do not merge; keep BLOCKED / NOT ACCEPTED and record exact failed criterion.

## Where this work ends
The assignment ends only with one of these two recorded outcomes:
- **ACCEPTED + MERGED:** all acceptance criteria pass on the exact final SHA, PR #32 is merged and closed, merge SHA and post-merge checks are recorded.
- **BLOCKED / NOT ACCEPTED:** one or more gates fail or cannot be proven; PR #32 stays unmerged, precise evidence and next action are recorded. No false completion.

## Scope boundaries
- Do not open a new branch/PR or start another task while PR #32 awaits repair, verification or closure.
- Do not touch other DevMate PRs, other repositories, RateNest or any unrelated project.
- No direct changes to `main`; follow repository governance and approval gates.
- No live migration/cutover on user data, deployment, deletion, pruning, marker removal or other destructive action.
- Do not use Google Jules without explicit owner approval.
- Never claim tests, CI, deployment, merge or closure without exact evidence.

**First action:** read the latest Operations Room and STATUS, re-fetch PR #32, then wait for / locate Claude's repair handoff. The Operations Room is where you coordinate and record every step.
