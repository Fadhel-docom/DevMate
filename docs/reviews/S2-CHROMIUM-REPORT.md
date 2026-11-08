# S2 — real-Chromium results (PR-D cutover controller)

- **Code under test:** PR #33 head `752445ced37d8dcf2bb35402de543812f0e0e3b9` (contains PR #32 head `a853f2af71383fb863171533e05588f54a86c86b`); `src/` diff against it is empty. Exact-head CI of PR #33: [run 42454182359](https://github.com/Fadhel-docom/DevMate/actions/runs/42454182359) (336 tests, vitest/jsdom — **not** re-run locally, no vitest here).
- **Browser/environment:** Chromium 153.0.8010.12 (headless, `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36`), Playwright 1.63.0, esbuild 0.28.2, Node v22.23.4, Linux 6.18.44-fc-v310 x64, 2 CPUs. Run 2026-11-08T11:47:49.457Z → 2026-11-08T11:51:00.686Z.
- **Result:** 15 scenarios, **13 PASS, 2 FAIL**, 64/66 checks. The 2 FAILs are findings about the design expectation, not harness errors. Raw data: `e2e/s2-browser-persistence/results.json`.
- Harness: `e2e/s2-browser-persistence/` (see its README). Earlier S1 harness `e2e/s1-legacy-writer` (Chromium 131) was not redone.

| # | Scenario | Status |
|---|---|---|
| S2-01 | Lifecycle baseline with the real production stages in real Chromium | **PASS** (4/4) |
| S2-02 | Two tabs race to declare intent (real Web Locks) | **FAIL** (2/3) |
| S2-03 | Three tabs resume() concurrently with real stages; an observer tab logs storage events | **PASS** (4/4) |
| S2-04 | Web Locks mutual exclusion and visibility (real), with an unlocked control | **FAIL** (1/2) |
| S2-05 | Lock timeout, then holder death releases the lock (real tabs) | **PASS** (3/3) |
| S2-06 | Real Chromium localStorage quota exhaustion at each controller write point | **PASS** (9/9) |
| S2-07 | Storage genuinely blocked (sandboxed opaque-origin iframe: real SecurityError) | **PASS** (3/3) |
| S2-08 | Marker read failure, write failure and write-then-unreadable (FAULT INJECTION at the Storage API boundary) | **PASS** (10/10) |
| S2-09 | Real browser restart at every lifecycle phase (persistent profile, clean exit, relaunch) | **PASS** (4/4) |
| S2-10 | Process crash (SIGKILL) after cutover writes, then relaunch: what survives, and is it ever inconsistent? | **PASS** (6/6) |
| S2-11 | Cross-tab consistency of the marker (reader tabs vs writer tab) | **PASS** (2/2) |
| S2-12 | Pre-loaded OLD tab autosaves after each lifecycle phase (real old code, real Chromium) | **PASS** (5/5) |
| S2-13 | OLD deleteBackup / restoreBackup / load-with-backup after each phase (UI-shaped calls, real Chromium) | **PASS** (5/5) |
| S2-14 | OLD tab waits behind the controller's real lock, then writes after release / times out / is closed | **PASS** (5/5) |
| S2-15 | Back/forward cache (BFCache) probe for a stale old tab | **PASS** (1/1) |

## Key findings

1. **FAIL S2-02 — two tabs racing `begin()` can both report `changed:true` (7 of 60 trials).** Marker and preserved copy end consistent (`intent`, one copy) in every trial, but the "exactly one tab writes" expectation does not hold: Chromium localStorage reads in the second tab can still return the old (null) marker for ~1–2 ms after the first tab's write, even though the tab holds the Web Lock. Microsecond traces are in the evidence.
2. **FAIL S2-04 — the Web Lock gives mutual exclusion (`query()` shows 1 held + 2 pending) but does not make a localStorage read-modify-write lost-update-free across tabs.** 3 tabs × 30 increments under the real lock produced 56–77 of 90 over repeated runs (unlocked control 30–36). Reads taken right after acquiring the lock can be stale. Any design that relies on "lock held ⇒ latest value visible" is not supported by this build; the controller's idempotent, revalidating steps are what keeps S2-02/S2-03 consistent.
3. **Old writers (R1) confirmed in real Chromium.** S2-12: old autosave succeeds 20/20 after intent, profiles-verified, stores-verified and committed, is detected afterwards (`source-changed`) and never touches the marker. S2-13: UI-shaped old `deleteBackup` deleted 3/3 backups at every phase and the controller does **not** detect it (current `deleteBackup` refuses with `cutover-active`); old `restoreBackup` succeeds and is detected; an old bundle merely loading after `intent` writes a new backup slot undetected.
4. **Old tab queued behind the lock (S2-14):** it writes after release (waited 718 ms), then is detected; if the lock is held > 8 s it fails with `lock-timeout` and writes nothing; closing the waiting tab drops the queued write.
5. **Crash (S2-10, SIGKILL):** the flushed baseline always survives byte-identical, no marker ever survives without its preserved copy, no state ahead of its data, no lock left held, `resume()` always completes to committed. But Chromium defers localStorage flushes: a marker written within ≈4 s before the kill was **lost** (kept from 5 s on); the earlier phase then simply reappears. This is a durability property of the browser, not of the controller.
6. **Quota (S2-06), blocked storage (S2-07), marker faults (S2-08), restarts (S2-09), cross-tab marker visibility (S2-11):** all PASS. Quota failures are reported and retriable; a tab does *not* see another tab's quota exhaustion (it could still store 20 KB) — each tab's old-writer failure only appears once the tab itself hits the limit.

## Per-scenario record (steps · actual result · not tested)

### S2-01 — Lifecycle baseline with the real production stages in real Chromium — PASS
- **Expected:** legacy -> intent -> profiles-verified -> stores-verified -> committed; legacy bytes untouched; current writers refused
- **Steps:** seed legacy workspace; preflight + begin + 3x advance with createCutoverStages() (real profile/ledger stores); after each step read the marker; call the three CURRENT mutators
- **Checks:**
  - PASS: marker phases are exactly intent, profiles-verified, stores-verified, committed
  - PASS: inspect() reports durable
  - PASS: legacy bytes unchanged and preserved copy equals the original
  - PASS: all three CURRENT mutators refuse with cutover-active
- **Not tested / limits:** nothing beyond the global list below.

### S2-02 — Two tabs race to declare intent (real Web Locks) — FAIL
- **Expected:** exactly one tab writes the intent marker; the other is idempotent; one preserved copy
- **Steps:** 60 trials: fresh context, two tabs; both preflight the same source, then both begin() at the same wall-clock instant; every marker/preserved-copy getItem/setItem is traced with a microsecond wall-clock stamp (read-only logging wrapper around the real Storage methods; values are logged as null / length)
- **Checks:**
  - PASS: every trial: both begin() calls ok
  - **FAIL**: every trial: exactly one tab reports changed:true
  - PASS: every trial: marker is intent and exactly one preserved copy exists
- **Not tested / limits:** nothing beyond the global list below.

### S2-03 — Three tabs resume() concurrently with real stages; an observer tab logs storage events — PASS
- **Expected:** marker moves strictly forward, each phase value written once, all tabs converge on durable
- **Steps:** 15 trials: observer + 3 worker tabs; worker A reaches intent; all three workers call resume() at the same instant; observer records every marker value from storage events
- **Checks:**
  - PASS: every resume() returned ok
  - PASS: observed marker values (from the other tab) are strictly increasing phases, no repeat, no regression
  - PASS: the last observed marker value is committed in every trial
  - PASS: all three tabs report durable afterwards
- **Not tested / limits:** nothing beyond the global list below.

### S2-04 — Web Locks mutual exclusion and visibility (real), with an unlocked control — FAIL
- **Expected:** with the lock no update is lost; query() shows 1 held + N pending
- **Steps:** 3 tabs x 30 read-yield-write increments of one counter key WITH withStorageLock; same WITHOUT a lock (control); one tab holds the lock, two request it, a fourth tab calls navigator.locks.query()
- **Checks:**
  - **FAIL**: with the real lock the counter is exactly 90 (no lost update) and no request failed
  - PASS: navigator.locks.query() shows one held and two pending exclusive requests for the storage lock
- **Not tested / limits:** The unlocked control is informational: its lost-update count varies by run and is not an assertion.

### S2-05 — Lock timeout, then holder death releases the lock (real tabs) — PASS
- **Expected:** begin() gives lock-timeout after ~8 s and writes nothing; closing the holder lets the next attempt succeed
- **Steps:** tab H holds the storage lock; tab C preflights and calls begin() (default 8000 ms lock timeout); close H; C calls begin() again
- **Checks:**
  - PASS: while held: lock-timeout after roughly 8 s (7.5-9.5 s)
  - PASS: the timed-out begin() wrote neither marker nor preserved copy
  - PASS: after the holder tab closed, begin() succeeds immediately (< 1 s) and nothing is left held
- **Not tested / limits:** nothing beyond the global list below.

### S2-06 — Real Chromium localStorage quota exhaustion at each controller write point — PASS
- **Expected:** every quota failure is reported, nothing is silently half-advanced, and recovery works once space returns
- **Steps:** (a) storage full at begin(); (b) room for the preserved copy but not the marker; (c) marker written, then storage full during the real stage writes; (d) room for stages (trivial) but not for the longer next-phase marker; then exactly enough; (e) the OLD writer on a full storage
- **Checks:**
  - PASS: (a) begin() on a full storage fails with preserve-quota and writes no marker/copy
  - PASS: (a) after space is freed the same plan succeeds (intent)
  - PASS: (e) the old writer, filling storage itself so its new payload cannot fit, reports a failure and leaves the workspace byte-identical
  - PASS: (b) begin() fails with marker-write-failed; the preserved copy exists, no marker; state is still legacy
  - PASS: (b) retry after freeing space is idempotent for the existing copy and reaches intent
  - PASS: (c) advance() reports stage-failed and the marker does not move
  - PASS: (c) after space returns, resume() reaches committed and inspect() is durable
  - PASS: (d) with less space than the growth (11 chars, tried 5) advance fails with marker-write-failed and the marker bytes are unchanged
  - PASS: (d) with exactly the growth available (11 chars, tried 11) the advance succeeds
- **Not tested / limits:** Quota behaviour of other browsers; the quota size is Chromium's, measured here by probing, not assumed.

### S2-07 — Storage genuinely blocked (sandboxed opaque-origin iframe: real SecurityError) — PASS
- **Expected:** controller and writers report unavailability and never throw; nothing is written
- **Steps:** load the real bundles inside <iframe sandbox="allow-scripts">; touch localStorage and navigator.locks; run controller, current writer and old writers with default storage
- **Checks:**
  - PASS: localStorage access really throws SecurityError in this frame
  - PASS: controller: inspect() indeterminate/unreadable, begin() storage-unavailable, nothing thrown
  - PASS: current and old writers return failures instead of throwing
- **Not tested / limits:** nothing beyond the global list below.

### S2-08 — Marker read failure, write failure and write-then-unreadable (FAULT INJECTION at the Storage API boundary) — PASS
- **Expected:** fail closed, never write a wrong marker, never report success that did not happen; recovery on retry
- **Steps:** page-level patch of Storage.prototype getItem/setItem that throws ONLY for the marker key; the real controller and real current writers run unmodified; 5 sub-cases
- **Checks:**
  - PASS: 1: marker unreadable -> inspect indeterminate/unreadable; begin() refuses (marker-invalid); no marker, no copy, legacy untouched
  - PASS: 1: the CURRENT write barrier fails closed (SecurityError -> unavailable, other -> cutover-indeterminate; restore/delete too)
  - PASS: 2: begin() reports marker-write-failed, no marker exists, one preserved copy remains, state legacy
  - PASS: 2: retry after the fault clears reaches intent without duplicating the copy
  - PASS: 3: begin() reports marker-verify-failed although the marker IS stored (the report is conservative, not wrong in the dangerous direction)
  - PASS: 3: once readable, inspect() = recovery and a repeated begin() is idempotent (changed:false)
  - PASS: 4: second marker read (after the stage) fails -> marker-invalid, marker did not advance, stage side effects remain
  - PASS: 4: the retry completes the phase (stage is idempotent)
  - PASS: 5: advance() reports marker-write-failed; marker bytes unchanged; inspect() = recovery
  - PASS: 5: retry after the fault clears advances
- **Not tested / limits:** These faults are injected at Storage.prototype for ONE key; the genuine whole-storage failures are S2-06 (quota) and S2-07 (SecurityError).

### S2-09 — Real browser restart at every lifecycle phase (persistent profile, clean exit, relaunch) — PASS
- **Expected:** all storage bytes survive the restart; inspect() reports the phase's state; resume() completes to committed
- **Steps:** for each of: no marker, intent, profiles-verified, stores-verified, committed; launch persistent context, seed, drive the real controller to the phase; dump all localStorage, close the browser, relaunch with the same profile directory; dump again and compare; inspect(); resume()
- **Checks:**
  - PASS: every phase: the complete localStorage dump is byte-identical after the restart
  - PASS: every phase: inspect() after the restart equals the expected mode (legacy/recovery/recovery/recovery/durable)
  - PASS: every phase: resume() reaches committed; legacy bytes unchanged; preserved copy equals the original
  - PASS: after restart the current writers stay blocked once a marker exists
- **Not tested / limits:** Clean browser exit only; abrupt kill is S2-10. The real App UI after restart is not run here (see report: React 19 on this host, the repository pins 18).

### S2-10 — Process crash (SIGKILL) after cutover writes, then relaunch: what survives, and is it ever inconsistent? — PASS
- **Expected:** the pre-crash (flushed) state always survives; recent writes may be lost but never half-lost; after relaunch resume() always reaches committed
- **Steps:** profile 1: seed the legacy workspace (and, for 'resume' trials, drive to intent) and exit the browser CLEANLY so that state is flushed; profile 2 relaunch: run the real controller call (begin, or resume), wait D ms after it RETURNED, SIGKILL every process of the profile; profile 3 relaunch: dump, inspect(), then resume(); separate case: kill while advance() holds the lock inside a stage that never returns
- **Checks:**
  - PASS: every trial really killed the browser (>=1 process matched)
  - PASS: the flushed baseline (legacy workspace) survives every crash byte-identical
  - PASS: never half-written: a surviving marker always has its preserved copy (no marker-without-copy)
  - PASS: never ahead of its data: a surviving phase beyond intent always has the migrated profile data
  - PASS: after every crash the state is defined (legacy or recovery, never indeterminate), no lock is left held, and resume()/begin completes to committed
  - PASS: mid-stage crash: the lock was held when killed; after relaunch it is free, state is recovery, resume() reaches committed/durable
- **Not tested / limits:** SIGKILL of the browser in a container is not an OS crash or power loss: the OS page cache survives it, so this says nothing about fsync-level durability after a kernel panic. A renderer-only crash (page crash, browser alive) was not separately exercised. The loss window is measured on this build/host only; it is Chromium's deferred localStorage flush, not a property of the controller, and is not a portable guarantee.

### S2-11 — Cross-tab consistency of the marker (reader tabs vs writer tab) — PASS
- **Expected:** all tabs converge; any stale read is measured, not assumed
- **Steps:** 30 trials: writer tab declares intent; a second tab reads the marker immediately after begin() resolved; poll until the reader sees the new value (settle time); after a full resume() every tab's inspect() is compared
- **Checks:**
  - PASS: every reader eventually sees the writer's marker (within 3 s)
  - PASS: after resume() all three tabs report durable in every trial
- **Not tested / limits:** Informational (not asserted): 0/30 immediate cross-tab reads were stale in this run.

### S2-12 — Pre-loaded OLD tab autosaves after each lifecycle phase (real old code, real Chromium) — PASS
- **Expected:** documents the gap: the old writer is NOT blocked at any phase; the controller detects the changed bytes
- **Steps:** old tab loads (readProjectsLocked) BEFORE intent; new tab drives the real controller to the phase; old tab runs its real autosave: saveProjectsLocked(snapshot, undefined, baselineRaw); new tab inspect() and advance(); exportPreservedSource()
- **Checks:**
  - PASS: GAP CONFIRMED: the old autosave succeeds in 20/20 trials, at every phase
  - PASS: the new side detects it: inspect() indeterminate/source-changed and advance() refuses with source-changed
  - PASS: the old write does not touch the marker bytes at all
  - PASS: the original bytes stay preserved and the divergent bytes are preserved too (2 copies); the marker never advances past its phase
  - PASS: contrast: the current writer is refused (cutover-active) in the same state
- **Not tested / limits:** nothing beyond the global list below.

### S2-13 — OLD deleteBackup / restoreBackup / load-with-backup after each phase (UI-shaped calls, real Chromium) — PASS
- **Expected:** documents which old mutators the controller can and cannot see
- **Steps:** seed workspace + three legacy backup slots (+ .meta) as fixtures; old tab loaded before intent; drive to the phase; (i) old deleteBackup(key, undefined, fingerprint) for every listed backup; (ii) old restoreBackup(key, undefined, fingerprint); (iii) an old bundle LOADING after intent on a workspace in 'recovered' shape (readProjectsLocked writes a backup)
- **Checks:**
  - PASS: (i) GAP CONFIRMED: old deleteBackup (UI-shaped, with fingerprint) deleted all 3 backups at every phase
  - PASS: (i) the controller does NOT detect it: inspect() unchanged, legacy bytes unchanged, abort-eligibility verdict unchanged
  - PASS: (i) contrast, measured BEFORE the old delete: the CURRENT deleteBackup refuses (cutover-active) and the backup is still there
  - PASS: (ii) old restoreBackup succeeds at every phase, changes the legacy bytes, creates a pre-restore snapshot slot, and is detected (source-changed)
  - PASS: (iii) an old bundle loading after intent WRITES a new backup slot (workspace untouched, marker untouched) and the controller does not see it
- **Not tested / limits:** nothing beyond the global list below.

### S2-14 — OLD tab waits behind the controller's real lock, then writes after release / times out / is closed — PASS
- **Expected:** serialization only: the old write lands after release; it is refused only by the 8 s timeout; closing the waiter drops the write
- **Steps:** new tab runs advance() with a stage gated open (holds the real lock); old tab starts its real autosave -> pending request; variant A: release the gate before 8 s; variant B: keep holding for > 8 s; variant C: close the waiting old tab, then release
- **Checks:**
  - PASS: A: while the controller holds the lock the old write is pending (1 held, >=1 pending) and the workspace is unchanged
  - PASS: A: the controller's advance finishes first (profiles-verified), THEN the old write succeeds
  - PASS: A: afterwards the controller detects it (indeterminate/source-changed, next advance refused, divergent bytes preserved)
  - PASS: B: held > 8 s -> the old write fails with lock-timeout after ~8 s, workspace unchanged, controller still recovery (nothing divergent)
  - PASS: C: closing the waiting old tab removes its pending lock request and the queued write never happens
- **Not tested / limits:** nothing beyond the global list below.

### S2-15 — Back/forward cache (BFCache) probe for a stale old tab — PASS
- **Expected:** if the old tab is restored from BFCache, record that it can still write; otherwise record that BFCache was not exercised
- **Steps:** old tab loads and baselines, navigates to another same-origin page, goBack(); read pageshow.persisted; if persisted: drive the real controller to intent in another tab, then run the restored tab's autosave
- **Checks:**
  - PASS: recorded honestly: goBack() did not restore from BFCache in this build (probe result stored in evidence)
- **Not tested / limits:** BFCache was NOT exercised: after goBack() the page was reloaded (in-memory marker lost), so a BFCache-restored stale tab could not be tested in this headless Chromium.

## Not tested (global)
- The real React App UI (host has React 19 vs the pinned 18; no vite/vitest): helpers reproduce the base App/BackupManager call shapes against the real legacy functions instead.
- BFCache: the S2-15 probe did not get a BFCache restore in headless Chromium 153 (`pageshow persisted=false`), so BFCache behaviour is **inconclusive, not tested**.
- OS crash / power loss (SIGKILL keeps the OS page cache), renderer-only crash, other browsers, mobile browsers, suspend/resume, a deployment during a pending write.
- The vitest suite was not run locally (relied on CI run 42454182359).
- No S3, no cutover, no migration, no production code change, nothing merged.
