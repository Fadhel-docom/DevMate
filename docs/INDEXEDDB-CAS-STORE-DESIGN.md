# IndexedDB + compare-and-set workspace store — design (design phase only)

- **Status:** DESIGN. No production code, no migration, no cutover, no S3. PR #32, #33, #35, #36 are untouched; S2-16 and its results are unchanged and remain the acceptance reference.
- **Basis:** `docs/reviews/S2-16-ROOT-CAUSE-INVESTIGATION.md` (PR #36): in Chromium 153 a `localStorage` compare-and-set inside a Web Lock is unsound because the second tab's compare read can be stale (35/35 and 20/20 both-ok trials). Code references are to `src/` at PR #33 head `752445ced37d8dcf2bb35402de543812f0e0e3b9`.
- **What this document must make possible:** every claim below is tied to a test (section 9) that can fail. Platform behaviours that are *assumed from the IndexedDB specification and not yet observed in this repository* are listed as **A1…A9** (section 11) and are each verified first, in real Chromium, by the first implementation PR before anything depends on them.
- **R1 is NOT declared solved by this design.** Section 6 states exactly what changes, what does not, and what remains open.

## 1. Goals and non-goals

Goals: (1) no lost update between tabs of the *new* application: an update acknowledged as saved is in the store, or the save reports conflict; (2) backups, restore and delete obey the same discipline; (3) every failure fails closed, with nothing half-written; (4) migration is resumable, idempotent and never destroys the legacy bytes; (5) everything above is provable in real Chromium with multiple tabs.

Non-goals: S3, executing any migration or cutover, changing PR-D's controller in this phase, other browsers beyond a documented gap, cross-device sync, encryption.

## 2. Database layout (`devmate-store`, version 1)

One database, one schema version at first. All values are structured-cloneable plain objects.

| Object store | Key | Value | Purpose |
|---|---|---|---|
| `records` | `name` (`"workspace"`; later `"project-profiles"`, `"task-ledger"`) | `{ name, version: int >= 1, raw: string, updatedAt: number, writer: string, schema: 1 }` | Current value per logical store. `raw` is the exact serialized JSON string (byte fidelity, parity with today's `storageRaw`/fingerprint). |
| `backups` | `id` (auto-increment) | `{ id, createdAt, reason: "corrupt" \| "invalid" \| "recovered" \| "pre-restore" \| "pre-migration", raw, sourceName, sourceVersion: int \| null, origin: "app" \| "legacy-localstorage", legacyKey: string \| null }` | Replaces `devmate-workspace-v1.unreadable-backup[.N]` (+ `.meta`). Rows are immutable once written (only deletable). |
| `legacy-archive` | `key` (verbatim localStorage key) | `{ key, raw, capturedAt, migrationId }` | Byte-exact copy of the legacy workspace and legacy backup keys taken at migration (section 5). Never modified or deleted by the app. |
| `orphans` | `id` (auto-increment) | `{ id, detectedAt, legacyKey, raw, reason: "workspace-changed" \| "backup-added" \| "backup-removed", migrationId }` | Evidence of writes by pre-barrier tabs after migration (section 6). |
| `meta` | `key` | `schema`, `migration` (state machine, section 5), `legacyFingerprints` (workspace raw hash + sorted key list at commit) | Authoritative migration state. |

**Version semantics.** `version` is a per-record monotonic integer: it starts at 1 on creation and every successful write sets `new = old + 1`; it never decreases and is never reused; the record is never deleted by application code (a "clear" is a write of the empty workspace). `expectedVersion = 0` means "expect that the record does not exist" (create-only). A tab's baseline is therefore a `version` (an integer), not a raw string; this removes the fingerprint-by-content weakness (same bytes with a different history are indistinguishable today).

Limit: `MAX_BACKUPS = 20` is kept as the *policy* for app-created backups (parity with `storage.ts:` `MAX_BACKUPS`); when full, `protect-original` refuses the write exactly as today instead of evicting (decision D6).

## 3. Interfaces (TypeScript, design signatures — not implemented)

```ts
type StoreName = "workspace" | "project-profiles" | "task-ledger";
type Failure =
  | "unavailable" | "blocked-upgrade" | "version-changed" | "closed"
  | "conflict" | "quota" | "invalid-data" | "protect-original"
  | "not-found" | "stale-backup" | "tx-aborted" | "unknown";

interface CasStore {
  // reads: one readonly transaction, consistent snapshot
  read(name: StoreName): Promise<{ ok: true; version: number; raw: string | null } | { ok: false; reason: Failure }>;
  // write: CAS in ONE readwrite transaction over [records, backups]
  write(name: StoreName, raw: string, expectedVersion: number,
        opts?: { protectOriginal?: { reason: BackupReason } }): Promise<
      { ok: true; version: number; backupId?: number } | { ok: false; reason: "conflict"; currentVersion: number } | { ok: false; reason: Failure }>;
  listBackups(): Promise<BackupInfo[]>;                       // readonly txn
  restoreBackup(id: number, expect: { backupRaw: string; workspaceVersion: number }): Promise<
      { ok: true; version: number; snapshotId: number | null } | { ok: false; reason: "stale-backup" | "conflict" | Failure }>;
  deleteBackup(id: number, expectedRaw: string): Promise<{ ok: true } | { ok: false; reason: "stale-backup" | "not-found" | Failure }>;
  onChange(cb: (e: { name: StoreName; version: number }) => void): () => void; // BroadcastChannel hint only; correctness never depends on it
  close(): void;
}
```

`readProjectsLocked`/`saveProjectsLocked` (storage.ts:284-296) become thin adapters over `read`/`write` that keep the existing result shapes (`LoadResult`, `SaveResult`: `raw` replaced by `version` plus the retained `raw`), so UI messages remain. `listBackups` is currently synchronous (`BackupManager.tsx:18`); it becomes async (the one structural UI change).

**Web Locks are not used for correctness any more.** They may remain as an optional latency optimisation (avoid doomed concurrent attempts); the invariants below must hold with the lock removed, and a test removes it (section 9, T-NL).

## 4. Transactions (all CAS decisions are made inside one IndexedDB transaction)

Common rules (each is a test target): (i) do all JSON validation/parsing/serialisation **before** opening the transaction; (ii) inside the transaction `await` only promises settled by IDB request callbacks (never `fetch`, timers, `navigator.locks`) to avoid auto-commit before the `put` (assumption A3); (iii) the result is reported to the caller only from `transaction.oncomplete`, never from request `onsuccess`; (iv) transactions are opened with `{ durability: "strict" }` (A4); (v) any exception or non-CAS outcome calls `transaction.abort()` so nothing partial is committed; (vi) the transaction's object-store scope is declared up front and always includes every store it may write, so two competing writers have overlapping scope and are serialized by the browser (A1).

**`write(name, raw, expectedVersion, opts)`** — scope `["records", "backups"]`, mode `readwrite`:
1. `cur = records.get(name)`.
2. `curVersion = cur?.version ?? 0`. If `curVersion !== expectedVersion` → abort, return `conflict` with `currentVersion` (nothing written).
3. If `opts.protectOriginal` and `cur.raw` is corrupt/invalid/recovered (the classification `inspectRaw` at storage.ts:123-131, run synchronously on the already-read value): count backups; if `>= MAX_BACKUPS` abort with `protect-original`; else `backups.add({... raw: cur.raw, reason, sourceVersion: curVersion})`. This is atomic with the write (today it is backup-then-write in two steps: storage.ts:209-211).
4. `records.put({ name, version: curVersion + 1, raw, updatedAt, writer, schema: 1 })`.
5. On `oncomplete` resolve `{ ok: true, version: curVersion + 1 }`. On `onabort` classify `transaction.error.name`: `QuotaExceededError` → `quota`; `ConstraintError`/others → `tx-aborted`/`unknown`; no write occurred in any aborted case.

**`restoreBackup(id, { backupRaw, workspaceVersion })`** — scope `["records", "backups"]`, `readwrite`, single transaction:
1. `b = backups.get(id)`; missing → `not-found`; `b.raw !== backupRaw` → `stale-backup`.
2. `cur = records.get("workspace")`; `(cur?.version ?? 0) !== workspaceVersion` → `conflict` (**this closes the gap noted in the investigation: today `restoreBackup` never compares the workspace, storage.ts:331-334**).
3. Validate `b.raw` is a lossless parse (`inspectRaw` kind `ok` or `empty`), otherwise `invalid-backup`-equivalent `invalid-data`.
4. If `cur` exists: `backups.add({ raw: cur.raw, reason: "pre-restore", sourceVersion: cur.version })` (count check as in write); then `records.put({ version: cur.version + 1, raw: normalized, ... })`.
5. Resolve on `oncomplete`. There is **no rollback code path**: failure = abort = untouched workspace, which removes today's "verify failed, rollback unverified" branch (storage.ts:353-366).

**Restore versus ordinary save.** Both are `readwrite` transactions on `records`; the browser serialises them (A1). Whichever runs second observes the other's version bump and returns `conflict`. The UI must pass the workspace `version` it displayed when the user opened the confirm dialog; a `conflict` tells the user the workspace changed and offers refresh (parity with `stale-backup`). Outcomes allowed by the invariants: restore-then-save(conflict), save-then-restore(conflict), never both acknowledged from the same base.

**`deleteBackup(id, expectedRaw)`** — `readwrite` on `backups`: get; compare raw; delete; resolve on complete.

**`read`** — `readonly` transaction (snapshot-consistent for its stores) returning `{version, raw}`; the caller keeps `version` as the baseline for the next `write`.

**Tab-local save queue.** `App.tsx:123-140` already serialises one tab's saves; the baseline advances from `{ ok: true, version }` returned by `write`.

## 5. Migration from `localStorage` (design only; nothing is executed in this phase)

Sources: `devmate-workspace-v1`, `devmate-workspace-v1.unreadable-backup[.2…20]` and their `.meta` keys. Target: `records.workspace`, `backups`, `legacy-archive`. Existing PR-D marker `devmate-cutover-v1:workspace` is unchanged by this design (decision D3).

State machine in `meta.migration` (every transition is one IndexedDB transaction, so each is atomic):

| Phase | Action | Crash/failed here ⇒ |
|---|---|---|
| `M0 preflight` (no write) | read legacy keys; compute fingerprints; probe IDB (`open`, one tiny put/delete in a scratch store); `navigator.storage.estimate()` must show room for 3× legacy size (A8). | Nothing written; try again later. |
| `M1 archive` | one transaction: `meta.migration = {id, phase:"archived", sourceFingerprint}` + `legacy-archive.put` for every legacy key (verbatim) | Atomic: either archive+phase or nothing; re-run is idempotent (same fingerprint ⇒ no-op; different fingerprint ⇒ stop, report divergence). |
| `M2 verify` (no write) | re-read legacy keys; they must equal the archive byte-for-byte (otherwise a legacy writer acted during migration: stop, record an `orphans` row, do not continue). | Resumes at M2. |
| `M3 commit` | one transaction: `records.add({name:"workspace", version:1, raw: normalised legacy})` **using `add`** (fails with `ConstraintError` if present ⇒ another tab already committed: re-read and continue as a reader), `backups.add` for each legacy backup (`origin:"legacy-localstorage"`, `legacyKey`, original `createdAt/reason` from `.meta`), `meta.migration.phase="committed"`, `meta.legacyFingerprints`. | Atomic. A second tab racing M3 gets `ConstraintError` for exactly one winner (test T-MIG-RACE). |

Rules: legacy keys are **never** deleted or modified by the migration (R2 is preserved); a later cleanup is a separate, owner-approved step, never automatic. If the legacy workspace is corrupt/invalid, the raw is archived, `workspace` starts empty at version 1 and a `backups` row with the matching reason is added (parity with `readProjects` at storage.ts:161-174). If the unreadable legacy backups exceed `MAX_BACKUPS`, all are still archived and imported (imported rows are never auto-evicted; decision D6). Failure handling: any phase failure leaves a consistent earlier phase; `resume` is the same function as `begin`.

## 6. R1 — old tabs after the application moves to IndexedDB (explicit, honest)

**What changes (provable):** already-loaded pre-barrier bundles only know `localStorage` (`saveProjects`, `saveProjectsLocked`, `restoreBackup`, `deleteBackup` at storage.ts:192, 284, 324, 376 in the legacy fixture). After the commit phase the live workspace is in `records.workspace`, which old code cannot reach. Their writes land in the abandoned legacy keys. Consequences: (a) the live workspace can no longer be overwritten or have its backups deleted by an old tab (today S2-12/S2-13 show it can); (b) the legacy bytes were archived at M1/M3, so legacy-side deletions destroy nothing that is not also preserved.

**What does not change (open):** old tabs can still *accept* edits and tell their user "saved" while writing to a copy nobody reads: silent **stranding** of user edits instead of silent **overwrite**. Prevention is not possible from inside the application (docs/PR-D-RECOVERY-DESIGN.md section 11.1), and this design does not claim otherwise.

**Mitigations (each with a test; none is a proof of quiescence):**
1. **Tripwire (detection, no data loss).** New tabs record `meta.legacyFingerprints` at commit, check the legacy keys at start-up and on every `storage` event (delivered to other same-origin documents when an old tab writes). Any change creates an `orphans` row (raw verbatim) and a visible banner offering the user a manual import (never auto-merge). Limit: detection happens only when a new tab is open or at the next start.
2. **Sentinel overwrite (optional, needs owner decision D4).** After M3 and a verified archive, the new app may write a fixed sentinel string to `devmate-workspace-v1`. An already-loaded old tab calling `saveProjectsLocked(..., expectedRaw = its baseline)` then gets `conflict` because the current raw differs (storage.ts:203-207 in the legacy fixture); an old tab that reloads sees a corrupt workspace and takes its backup path. This **violates R2's "legacy untouched"** wording, but the original bytes remain in `legacy-archive`, so the purpose of R2 (no destruction) is met; it is bounded by the same stale-read weakness for the few ms after the sentinel write. Old `deleteBackup`/`restoreBackup` are unaffected by it (they do not compare the workspace).
3. **Owner procedure (attestation, not proof):** close all tabs and restart browsers on every device before cutover (docs section 11.1 option b).
4. **Same-origin limitation:** only a different origin (11.1 option a) separates old code completely; out of scope here.

**R1 status after this design: UNRESOLVED.** It is *reduced* from "old writer destroys live data" to "old writer strands edits, detected when a new tab is present". Whether that residual is acceptable is an owner decision (D4/D5); the register entry must not be closed on the strength of IndexedDB alone.

## 7. Failures and platform events (fail closed; no fallback writer)

| Event | Behaviour | Test |
|---|---|---|
| `QuotaExceededError` on any readwrite txn | txn aborts atomically; return `quota`; UI keeps in-memory edits and offers retry/export; no localStorage fallback (a fallback writer would reintroduce the lost-update bug). | T-Q |
| `indexedDB.open` blocked / `onblocked` (an older-version tab still holds the DB during a schema upgrade) | return `blocked-upgrade` after a bounded wait (default 8 s, as `DEFAULT_LOCK_TIMEOUT_MS`); UI says "close other DevMate tabs"; no writes. | T-BLK |
| `onversionchange` in a tab holding the DB | **always** `db.close()` immediately, mark the store `version-changed`, refuse further operations, show a reload banner. This is what makes upgrades non-blocking. | T-VC |
| `db.onclose` (browser closed it abnormally, e.g. storage cleared) | mark `closed`; one reopen attempt; otherwise read-only mode with a visible warning. | T-DEL |
| Transaction `onabort`/`error` (`AbortError`, `UnknownError`, `TransactionInactiveError`) | map to `tx-aborted`/`unknown`; no result is reported as success without `oncomplete`. | T-ABT |
| `indexedDB` absent / `SecurityError` (opaque origin, blocked storage) | `unavailable`; application is read-only with a visible notice; never write `localStorage`. | T-UNAV |
| Tab crash/kill mid-transaction | IndexedDB discards uncommitted transactions; the record is either the old or the new version. | T-KILL |
| Schema version in DB newer than the bundle | refuse to write (`version-changed`); same rule as the durable stores' `future-version`. | T-FUT |

## 8. Backups and recovery summary

| Today (`localStorage`) | Proposed |
|---|---|
| backup written first, workspace written second (two steps, `storage.ts:209-211`) | backup `add` and workspace `put` in one transaction |
| `restoreBackup` compares only the backup slot (`storage.ts:334`) | compares backup raw **and** workspace version |
| restore rollback path with "rollback unverified" outcome (`storage.ts:353-366`) | none needed; abort = untouched |
| `fingerprint = raw` for stale checks | kept for backups; workspace baseline is `version` |
| legacy keys/slots | archived verbatim, imported as `origin:"legacy-localstorage"` rows, originals left in place |
| `.meta` JSON best-effort (`storage.ts:133`) | fields on the row, written atomically with the backup |

## 9. Real-Chromium test design (extends the existing `e2e/s2-browser-persistence` harness; no fakes of IndexedDB, locks or tabs)

Each test is real Chromium, real tabs in one browser context (two or more), the production module bundled unchanged, results recorded with exact SHAs and versions, FAILs reported, expectations never relaxed. "Acceptance" numbers below are minimums for the first merge candidate and may be raised, not lowered.

| ID | What | Pass criterion |
|---|---|---|
| **A-S2-16** | The S2-16 scenarios re-run against the CAS store: (A) 100 simultaneous saves from the same `expectedVersion` by two tabs; (B) 2 tabs × 50 retry-on-conflict edits; (C) sequential stale baseline; plus 3 and 5 tab variants | 0 trials with both acknowledged; 0 acknowledged edits missing; every loser gets `conflict` |
| **T-NL** | Same as A-S2-16 with Web Locks **disabled** (removing `navigator.locks` via `addInitScript`) | identical to A-S2-16: correctness does not depend on the lock |
| **T-RS** | Restore versus save race: tab A opens the confirm dialog at version v; tab B saves; A confirms; and the reverse order; also simultaneous, 100 trials each | never both acknowledged from the same base; restore never silently drops B's acknowledged edit; pre-restore snapshot exists after every acknowledged restore |
| **T-DEL** | delete backup versus restore of the same backup; concurrent delete from two tabs | exactly one wins; the other gets `not-found`/`stale-backup` |
| **T-ATOM** | at the abort points (quota override, forced abort) check that backup `add` and workspace `put` are both absent or both present | never half |
| **T-KILL** | SIGKILL of the persistent-profile browser at: during a save burst; during each migration phase M1–M3; during restore; then relaunch and inspect (same technique as S2-10) | record is exactly the old or the new version; migration resumes to `committed`; legacy keys byte-identical; no orphan state |
| **T-DUR** | durability A/B: `strict` versus default, SIGKILL 0/250/1000/4000 ms after the acknowledged save | report the loss window honestly (S2-10 measured ≈4 s for `localStorage`); acceptance = **0 acknowledged-and-lost writes with `strict`** or the finding is reported and D8 revisited |
| **T-RST** | clean restart at every migration phase and after commit | state and bytes preserved; `resume` idempotent |
| **T-MIG-RACE** | two/three tabs run `begin/resume` migration concurrently | exactly one `records.add` wins; one archive; no duplicate backups |
| **T-Q** | real quota exhaustion via the Chrome DevTools Protocol (`Storage.overrideQuotaForOrigin`, assumption A7) at: M1, M3, ordinary save, restore | atomic abort, `quota` reported, retry succeeds after space returns; nothing half-written |
| **T-BLK / T-VC** | tab A holds v1; tab B (bundle with schema v2) opens: blocked → A receives `versionchange`, closes, B proceeds; A shows banner; bounded-wait failure path | no deadlock; no write after `versionchange`; messages shown |
| **T-DEL-DB** | database deleted/cleared from another tab or CDP (`Storage.clearDataForOrigin`) | tab detects `onclose`/`unavailable`, goes read-only, no write to `localStorage` |
| **T-UNAV** | sandboxed opaque-origin iframe (as S2-07) | `unavailable`, nothing thrown |
| **T-OLD-\*** | with the real legacy fixture bundle (`src/__fixtures__/legacyStorage.base.ts`) as the old tab: old autosave / `deleteBackup` / `restoreBackup` / load after commit; new tab open and closed | live `records.workspace` byte-identical in every case; orphans/banner created when a new tab is present; archive intact; with D4 sentinel: old autosave returns `conflict` (measure the stale-read exception rate, report it) |
| **T-STALE** | repeat S2-04/S2-02-style cross-tab read-modify-write using only the CAS store | 0 lost updates (shows the earlier failures are specific to `localStorage`) |
| **T-PERF** | p50/p95 latency of `read`/`write` with the current workspace size and 20 backups | recorded; budget set by the owner (D8), not assumed |
| **Unit (vitest)** | pure functions (classification, version arithmetic, error mapping) | run in CI; IndexedDB itself is **not** simulated there (no `fake-indexeddb` is installed and the network is blocked in the author's environment; adding it is decision D7) |

Browsers other than Chromium are explicitly **untested** by this plan (documented gap, A9).

## 10. Implementation plan — small reviewable PRs (each gated by owner approval; each carries evidence, rollback and unchanged-S2-16 statement)

| PR | Content | Size | Gate / evidence |
|---|---|---|---|
| **P0** | this design (docs only) | docs | owner approval of the decisions in section 12 |
| **P1** | `src/casStore/` pure module: open/schema/`read`/`write` CAS + error mapping; **not imported by the app**; real-Chromium harness: A-S2-16, T-NL, T-STALE, T-ATOM, T-KILL (save), T-DUR; spike results for A1–A4 | ~400 lines + harness | A1–A4 observed or design revised; S2-16 acceptance met |
| **P2** | backups: `listBackups`, `restoreBackup`, `deleteBackup`, pre-restore snapshot, caps; T-RS, T-DEL | ~250 lines | T-RS/T-DEL pass |
| **P3** | failure handling: quota, blocked/versionchange, db close, unavailable; T-Q, T-BLK, T-VC, T-DEL-DB, T-UNAV | ~250 lines | CDP quota (A7) works or documented fallback |
| **P4** | migration module (M0–M3), `legacy-archive`, resumable; **not wired**; T-MIG-RACE, T-KILL(migration), T-RST | ~350 lines | rehearsal only on test profiles; no real data |
| **P5** | adapters + UI async changes behind a build-time flag (default off): `storage.ts` adapters, `App.tsx`, `BackupManager.tsx` (async list) | ~300 lines + tests | existing 336 tests stay green with the flag off; flag-on test pass |
| **P6** | R1 tripwire + orphans + banner (+ D4 sentinel if approved); T-OLD-* | ~250 lines | R1 stays **UNRESOLVED**; evidence recorded |
| **P7 (optional, D3)** | move profiles/ledger/durable stores onto `records` (multi-record atomic transactions may replace the journal in `durableStore.ts`) | large; design addendum first | separate design review |
| **P8** | enable flag in a rehearsal copy; owner-run real cutover only with explicit approval | n/a | out of scope until approved |

Rollback of each PR before P8: revert (the store is unused or flagged off). After P8: legacy keys and `legacy-archive` still hold the original bytes, and a documented export path can regenerate legacy-format keys (to be designed in P6).

## 11. Assumptions to verify first (observed in P1, not assumed afterwards)

- **A1** readwrite transactions with overlapping scope are serialised and isolated across tabs (the specification's guarantee) — verified by A-S2-16/T-STALE.
- **A2** `transaction.oncomplete` fires only after the data is committed and visible to a later transaction in another tab — verified by T-STALE.
- **A3** no auto-commit before the `put` when only IDB-settled promises are awaited — verified in P1 unit/real tests.
- **A4** `durability: "strict"` is accepted in Chromium 153 and survives SIGKILL after the acknowledgement — verified by T-DUR (may fail; if so reported).
- **A5** `ConstraintError` on `add` of an existing key gives exactly one winner — T-MIG-RACE.
- **A6** `versionchange`/`blocked` behave as specified with two real tabs — T-BLK/T-VC.
- **A7** CDP `Storage.overrideQuotaForOrigin` can induce a real `QuotaExceededError` for IndexedDB in this environment — first spike of P3; if not, T-Q is reported NOT TESTED.
- **A8** `navigator.storage.estimate()` is usable for the migration preflight; it is an estimate, not a guarantee.
- **A9** Behaviour in Safari/Firefox/mobile is unknown.

## 12. Risks and decisions needing the owner

Risks: R-A stranded edits by old tabs (section 6); R-B IndexedDB eviction/clearing by the browser (best-effort storage; `navigator.storage.persist()` may show a prompt in some browsers); R-C async `listBackups` changes the UI; R-D two sources of truth during the transition (localStorage marker versus `meta.migration`); R-E PR #32's controller currently migrates profiles/ledger into `localStorage` durable stores, which carry the same stale-read weakness (not tested for them directly); R-F no offline IndexedDB test double; R-G added latency per write (unmeasured).

| # | Decision | Recommended default |
|---|---|---|
| D1 | Adopt this architecture (P1 may start) | yes, P1 only, flag off |
| D2 | Scope of the first target | workspace + backups only; profiles/ledger later (P7) |
| D3 | Relation to PR #32's cutover controller and marker | keep the controller as is for now; IDB `meta.migration` authoritative for the workspace; revisit before P7; do not merge #32 on the assumption it fixes this |
| D4 | Sentinel overwrite of the legacy workspace key after archive (violates the literal R2) | decide after P6 measurements; default: **no sentinel** in P6, tripwire only |
| D5 | Acceptance of the stranded-edits residual for R1, or a different-origin plan | owner decision before P8; R1 stays open until then |
| D6 | Backup cap and imported-backup policy (never auto-evict) | as written in sections 2 and 5 |
| D7 | Allow a dev dependency for IndexedDB unit tests (e.g. `fake-indexeddb`) | optional; real-Chromium harness is authoritative either way |
| D8 | Latency/durability budget and what to do if `strict` still loses acknowledged writes | measure in P1, then decide |
| D9 | Who performs the real migration and on which devices | owner procedure, after P8 approval |

## 13. Explicitly not claimed
That IndexedDB solves R1; that IndexedDB is correct in any browser other than Chromium 153 on this host; that assumptions A1–A9 hold before P1 observes them; that profiles/ledger are safe; that the migration is safe to run (nothing was run); any performance figure.

## 14. Update and review notes (Claude, 2026-11-11; added when this branch was rebuilt on the current PR #36 head)

These notes change **no decision**: D1–D9 stay with the owner. Sections 1–13 above are unchanged.

### 14.1 Facts that changed since this document was written
- **PR #32 is merged**, with the cutover **unreachable from the production entry point** (the mutating controller is test-only; production imports only the read-only `src/cutoverState.ts`). The sentence in R-E and D3 about "PR #32's controller currently migrates profiles/ledger into `localStorage`" now describes test/harness code, not shipped behaviour. "Do not merge #32 on the assumption it fixes this" is moot; the original point stands: nothing in the shipped app migrates anything, and the localStorage durable stores share the localStorage + Web Lock substrate (an **unverified risk by shared substrate, not a demonstrated failure**; see PR #36 section 4 and the evidence matrix section 4.1).
- **PR #38 and #39 are merged**: an isolated `src/casStore/indexedDbCasStore.ts` and a real-Chromium harness (`e2e/cas-store-harness`, see `docs/reviews/P1-INDEXEDDB-CAS-SPIKE.md`). It is not imported by the app. It already gives real-Chromium evidence for part of A1 (same-baseline races with a negative control; the base record says 100/100 real races and mutant rejection), for atomic backup-plus-write (A-ATOM-like fault injection), for requested `strict` durability, and for `versionchange` handling. It does **not** cover SIGKILL durability, real quota exhaustion, restore races, migration, 3+ tabs, symmetric race ordering or other browsers (its own "not tested" list). So the plan's P1 is **partly done as a spike**; the P1 acceptance (A-S2-16 against the CAS store, T-NL, T-STALE, T-KILL, T-DUR) is not.
- The unit-test count quoted in P5 ("336 tests") is stale: the base now has 381.
- `S2-16-ROOT-CAUSE-INVESTIGATION.md` (PR #36) now includes an independent reproduction and a plain-`localStorage` cross-tab visibility measurement (delay typically about 0.5–4 ms on a slow host; never instantaneous).

### 14.2 Review comments on the design (for the owner/ChatGPT; each is a suggestion, none is applied)
1. **T-DUR cannot test what it claims with SIGKILL.** A killed browser process does not lose data that IndexedDB already handed to the operating system, whether durability is `strict` or relaxed; the ≈4 s loss window S2-10 measured for `localStorage` comes from Chromium batching localStorage commits inside the process, not from an OS cache. `strict` matters for OS crash or power loss, which this harness cannot induce. Suggested wording: SIGKILL tests prove *process-crash* atomicity and acknowledged-write survival (expected: 0 loss in both modes); the OS-crash/power-loss guarantee is reported as **not testable here**, and D8 is decided on that basis.
2. **M2 "verify" reads `localStorage`, the substrate whose cross-tab reads can be stale.** A legacy write made a few milliseconds before the re-read may not be visible, so M2 can pass while an old tab has just written. Suggested: say that M2 detects writes older than the visibility delay only; take the re-read after a settling pause and a second re-read at M3 time (outside the IDB transaction, before it opens); record the result as a heuristic. Measured delay: typically 0.5–4 ms, with an unexplained longer tail under CPU starvation (PR #36 section 7), so any fixed pause is a mitigation, not a proof.
3. **Detecting a wiped or recreated database.** `expectedVersion = 0` means "create-only". If the browser evicts or the user clears the database, a tab that previously saw version N would see no record and could treat a later write as a first creation. Suggested: store a random `dbInstanceId` in `meta` (and keep it in tab memory); a tab that sees a missing record or a different id must treat it as `closed`/`cleared` (read-only plus banner), not as create-only. This also strengthens T-DEL-DB.
4. **Make the failure-mapping table total.** `TransactionInactiveError`, `InvalidStateError` and `DataCloneError` can be thrown synchronously from `put`/`add`, before any `onabort`; the design maps only abort events. Add a `try/catch` around request creation, call `abort()` in the catch, and map thrown names, with a test.
5. **State what `oncomplete` before data is visible means (A2).** The CAS-store tests should read from a *new* tab immediately after the writer's acknowledgement (not only a fresh transaction in the same tab) so that the cross-process visibility question is answered for IndexedDB with the same instrument used for `localStorage` (PR #36's `diag-localstorage-visibility.mjs` can be adapted).
6. **Backup cap and `protect-original` interplay.** At `MAX_BACKUPS`, `protect-original` refuses the write (as today). Say explicitly that this can block *all* saves of a corrupt workspace until the user deletes a backup, and make the UI path part of P2; otherwise the fail-closed rule turns a corrupt record into a locked app.
7. **Sentinel (D4) wording.** The text says it is "bounded by the same stale-read weakness for the few ms after the sentinel write". Keep that, and add that an old tab that reloads would take its backup path and could create a *new* legacy backup row from the sentinel; the tripwire should classify that as expected noise (`reason: sentinel`) rather than as an orphan edit.
8. **Test list additions.** (a) Migration M1–M3 with a legacy write arriving *between* M2 and M3 (expected: detected by the tripwire as an orphan, not silently lost); (b) two `versionchange` consumers in one tab; (c) restore after a database wipe; (d) 3 and 5 tab A-S2-16 are listed, add a **mixed-speed** variant (one tab throttled via CDP CPU throttling) because the localStorage failure was host-timing dependent.

### 14.3 What this update does not do
It does not decide D1–D9, does not start P1 beyond the already-merged isolated spike, does not claim IndexedDB solves R1 or S2-16, and did not run any new IndexedDB experiment. R1 remains unresolved; live cutover remains prohibited.
