# S2-16 rebuild — evidence matrix (working baseline)

**Status:** evidence inventory, not a storage design and not an approval  
**Created:** 2026-11-09 by ChatGPT coordinator  
**Branch:** `design/indexeddb-cas-store` (PR #37; open, unmerged)  
**Purpose:** replace the missing-v4 recovery dependency with a traceable baseline from artifacts that are actually present. The original v4 is not recreated or represented here.

## 1. Executive finding

**S2-16 is a real, reproducible data-integrity failure in the legacy localStorage save path under the tested Chromium environment.** Two tabs can start from the same stored baseline, both call the real `saveProjectsLocked`, both receive success, and one acknowledged edit is absent from the final workspace.

The relevant production functions were exercised from `src/storage.ts` at PR #33 head `752445ced37d8dcf2bb35402de543812f0e0e3b9`. The S2-16 harness uses real Chromium tabs and real production storage functions; the helper creates the edited project list, rather than running the React UI.

This establishes the observed defect in that tested environment. It does **not** establish a universal browser claim, prove a fix, or authorize application integration.

## 2. Primary S2-16 evidence

| Case | Recorded result | Evidence classification | Limits |
|---|---|---|---|
| A — simultaneous saves from the same baseline | 40 trials: exactly one success in 25; both tabs reported `ok` in 15; one acknowledged edit was absent in each of those 15 | **Committed raw evidence, directly inspected** in `results.addendum-1.json`; summarized in report Addendum 1 | Two tabs, one Chromium build, helper-generated edits; not the React UI |
| A — repeat | Report records a repeat of 15/40 double-success trials | **Reported in committed report**; the repeat's separate raw output is not identified in the addendum file | Do not count as a second independently inspected raw artifact |
| B — sustained edits | Two tabs × 25 edits = 50 acknowledged; 48 present; 2 missing; 6 conflicts reported; no other failures | **Committed raw evidence, directly inspected** in `results.addendum-1.json` | Two tabs, 25 edits each, one browser profile |
| B — second run | Report records 1 missing edit in one run and 2 in another | **Reported in committed report**; raw data for both runs is not fully identified | Keep distinct from the 50-edit raw run above |
| C — sequential stale baseline | Second save 1.5 seconds after first returned `conflict`; final data retained first edit | **Committed raw evidence, directly inspected** | This sequential case does not cancel the simultaneous-race failure |

### Exact provenance

- Report: `docs/reviews/S2-CHROMIUM-REPORT.md`, Addendum 1; blob `3449adf99b9b50a3836a535af591915146f3584d`.
- Raw result: `e2e/s2-browser-persistence/results.addendum-1.json`; blob `bebe8cd01d80b44f18c12d100531dab9863f8868`.
- Harness commit recorded in result metadata: `dc2983e51dddc468e672637f1167a0dccdf7a26d` (clean at run time).
- Production code under test: PR #33 head `752445ced37d8dcf2bb35402de543812f0e0e3b9`; metadata states `src/` was byte-identical to that head.
- Environment: Chromium 153.0.8010.12; Playwright 1.63.0; Node v22.23.4; esbuild 0.28.2; Linux 6.18.44 x64; 2 CPUs.
- Reproduction command recorded by the harness: `node e2e/s2-browser-persistence/run.mjs S2-15 S2-16 --out=results.addendum-1.json`.

## 3. Root-cause diagnostic

The diagnostic instruments the real `saveProjectsLocked` path with read-only wrappers around `Storage.prototype.getItem/setItem` and `navigator.locks.request`. It does not change production code.

| Diagnostic variant | Trials | Both tabs returned success | Acknowledged edits missing | Meaning |
|---|---:|---:|---:|---|
| Real path, no artificial hold — first run | 60 | 35 | 35 | In all 35 both-success trials, the second tab's compare-read saw the old baseline; the first tab had already written |
| Real path, no artificial hold — repeat | 40 | 20 | 20 | Same observed pattern; timestamp data in one trial has a 0.1 ms overlap/skew caveat |
| Artificial 5 ms hold | 40 | 0 | 0 | Diagnostic timing experiment only |
| Artificial 25 ms hold | 40 | 0 | 0 | Diagnostic timing experiment only |
| Artificial 100 ms hold | 40 | 0 | 0 | Diagnostic timing experiment only |

### Mechanism supported by the observations

1. Each tab reads and retains an `expectedRaw` baseline before its save attempt.
2. `saveProjectsLocked` obtains the exclusive Web Lock, then calls synchronous `saveProjects`.
3. `saveProjects` reads localStorage and compares it with the caller's earlier `expectedRaw`; if equal, it writes the new serialized workspace.
4. The diagnostic observed that, shortly after tab A's completed write and after the lock was handed to tab B, tab B could still read the old baseline. Its compare therefore passed and its write overwrote A's acknowledged edit.

The exact `src/storage.ts` inspected at PR #33 head has this compare-before-write sequence in `saveProjects`, with `saveProjectsLocked` wrapping it in `withStorageLock`. The issue is not that the Web Lock failed to serialize the callback in the 60-trial diagnostic; the observed problem is that the cross-tab localStorage read can be stale after handoff.

**Not proven:** Chromium's internal implementation-level reason for the stale read; behaviour in other browsers; a general timing bound; or that any delay-based workaround is safe.

### Diagnostic hold experiment — explicitly not a fix

The 5/25/100 ms hold variants observed zero lost updates in 120 trials, but they deliberately change lock timing and are labelled diagnostic variants, not production code. The result is host- and timing-dependent evidence only. Do not implement a fixed delay or present it as a correctness guarantee.

### Provenance

- Root-cause report: `docs/reviews/S2-16-ROOT-CAUSE-INVESTIGATION.md`; blob `a21d60294643ba7d03ad0b980b9797c243600471`.
- Raw diagnostic: `e2e/s2-browser-persistence/diag-s2-16-results.json`; blob `b27eec4b57cd1fe8f0019bd7936914cabb9b5afa`.
- Diagnostic script: `e2e/s2-browser-persistence/diag-s2-16.mjs`; blob `f4f58e7103923c8ad54b8efb07779c56c0d72c9c`.
- Code inspected: `src/storage.ts` at PR #33 head `752445ced37d8dcf2bb35402de543812f0e0e3b9`; blob `168b71cdeef419fc4f077065a068ffee481b7003`.
- Diagnostic command: `node e2e/s2-browser-persistence/diag-s2-16.mjs <trials> [holdMs]`.
- Recorded variants: `hold0_run60`, `hold0`, `hold5`, `hold25`, `hold100`.

## 4. Related findings that must remain separate

### S2-02 and S2-04 — broader localStorage/Web Locks observations

The full S2 report and `results.json` record:
- S2-02: two tabs both reported `changed:true` in 7/60 intent races, while marker and preserved copy remained consistent.
- S2-04: the tested locked counter ended at 56 rather than 90 in the inspected run; the report records 56–77/90 across repeated runs. This shows that lock mutual exclusion did not guarantee fresh cross-tab localStorage reads in that environment.
- S2-15 (BFCache): **NOT TESTED**, because navigation reloaded the page and `pageshow.persisted=false`. Do not count it as PASS.
- S2-10: the report observed that localStorage writes made shortly before SIGKILL could be lost until the browser flushed them; this does not establish behaviour under OS crash or power loss.

These results support caution about localStorage concurrency and durability, but they are not substitutes for the direct S2-16 evidence.



## 4.1 Existing durableStore foundation — not proof of cross-tab safety

A separate inspection of the `feature/phase-1-foundation` branch found `src/durableStore.ts` (blob `90d44e21e48c0a22a1e2402fb524d14717690d54`) and `src/durableStore.test.ts` (blob `ead53f7399fae90ee365ae4fb3e0093f0cddabe2`).

- The durable store persists its data, journal, migration marker and backup slots in **localStorage**. It uses the shared Web Lock wrapper, compares a stored revision, writes an intent journal, writes the data, verifies it, then marks the journal committed.
- The unit-test setup injects a `runExclusive` stub that simply executes the callback and uses an in-memory `MemoryStorage`. These tests verify local control-flow and recovery cases, but they do not exercise real cross-tab localStorage propagation.
- The inspected `src/App.tsx` on `feature/phase-1-foundation` contains no reference to `createDurableStore`; no evidence was found in this inspection that this module is wired into the UI.
- Therefore this is **not a confirmed S2-16 defect in the durableStore module**, but it is a material unverified risk if the module is later relied on for cross-tab correctness. It uses the same localStorage + Web Lock substrate implicated by S2-16, and a revision read inside a lock is not by itself proof that the value is fresh across tabs.
- The word "durable" in this module's name must not be read as proof of IndexedDB transaction durability, cloud persistence, cross-device sync, or cross-tab correctness.

**Required follow-up for any adoption:** run real Chromium multi-tab tests against this exact module, including concurrent writes, restore, journal recovery, and stale reads after lock handoff. Until then, classify its cross-tab guarantee as **Unknown / not verified** and do not use it as the safety basis for the fresh S2-16 design.

### R1 — separate stale-writer boundary

The S2 report records old-bundle behaviour after cutover intent:
- Old autosave succeeded 20/20 after the tested lifecycle phases and was detected afterwards.
- Old `deleteBackup` deleted backups and was not detected by the controller.
- Old `restoreBackup` succeeded and was detected; an old bundle loading after intent could write a backup slot undetected.

**R1 remains unresolved and separate from S2-16.** Fixing S2-16 does not close R1; detecting R1 does not make S2-16 safe.

### IndexedDB CAS work

- PR #38 is an isolated IndexedDB CAS spike merged into `feature/phase-1-foundation`; it is not connected to the application storage path.
- PR #39 hardens a CAS harness. Its PR description reports exact-head CI and Chromium checks, but those results test the isolated CAS harness, not the legacy application save path.
- Neither PR #38 nor #39 proves that the app has been migrated to IndexedDB or that S2-16/R1 is resolved.

## 5. Historical claims explicitly excluded from the verified baseline

Do **not** present these figures as verified measurements unless their missing source artifacts are found and inspected:
- 23/100, 16/60, 34/200, 4/200, 3/100, 9/40 as carried by the v3 draft / earlier entry 70. The referenced `results-067bc06.json` is absent from the inspected branch tree; entry 71 already corrects their classification to reported-but-untraceable.
- Any statement that v3 or the earlier `INDEXEDDB-CAS-STORE-DESIGN.md` is an approved design.
- Any statement that the missing original v4 has been recovered or that this document reconstructs it.

The archived v3 draft and earlier proposal remain unchanged historical documents. This matrix does not endorse their architecture.

## 6. Scope and unknowns

Not established by the inspected evidence:
- Real React UI behaviour under the same race.
- More than two tabs for S2-16.
- Firefox, Safari, mobile browsers, other OSes or browser versions.
- BFCache-restored stale tabs.
- OS crash, power loss, renderer crash, suspend/resume, or deployment during a pending write.
- A safe localStorage-only correctness fix.
- Whether the current IndexedDB spike satisfies all product-level backup, recovery, durability, and compatibility requirements.
- The correct resolution for R1 and any production cutover procedure.

No new tests, builds, browser runs, or CI jobs were executed by ChatGPT while creating this matrix. The raw committed artifacts were inspected; their historical execution was not repeated.

## 7. Requirements for the fresh design draft

The next design draft must be based on this matrix and add evidence rather than repeat assumptions. At minimum it must specify:
1. One authoritative stored workspace representation and a version/revision protocol.
2. Atomic compare-and-set semantics across tabs, not merely a lock around localStorage.
3. Explicit outcomes for `committed`, `not-committed`, and `unknown`, with a reconciliation path for interrupted writes.
4. Idempotency keys and a rule against replaying an operation whose outcome is unknown until reconciled.
5. Backup creation, restore ordering, retention limits, quota handling, and fail-closed behaviour.
6. Compatibility and isolation from old localStorage writers, treating R1 as a separate gate.
7. An acceptance matrix derived from each verified failure, plus negative/mutant tests proving that the harness detects broken implementations.
8. A migration and rollback plan as a separate Sensitive-level proposal; no migration or cutover is authorized by this evidence matrix.

**Next action:** produce one fresh S2-16 design draft only after the source-linked requirements and unresolved owner decisions have been consolidated. Claude's single independent review is scheduled for that consolidated draft's exact SHA, not for this intermediate evidence inventory.
