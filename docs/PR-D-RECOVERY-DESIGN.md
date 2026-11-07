# PR-D — controlled application cutover and forward-only recovery design

**Status:** Design baseline for implementation planning; not an authorization to run migration or cut over storage.  
**Base:** `feature/phase-1-foundation` at PR-B merge `3665c694d29966188096c534dc7221b84f723dd4`.  
**Dependencies:** PR-B profile persistence (merged); PR-C task-ledger adapter (PR #28, pending independent review/merge).  
**Risk:** Sensitive — local user-data migration, recovery, and persistence cutover.

## 1. Objective and non-goals

PR-D connects the already-tested durable profile and task-ledger adapters to the application through a controlled, observable, recoverable transition. The UI must never claim that data is saved, migrated, restored, or safe when the relevant storage operation has not been verified.

PR-D does **not** connect AI providers, execute tasks, publish externally, change permissions, add paid services, or modify other repositories. It does not delete the legacy workspace key or legacy backup namespace.

No migration or cutover may run until the implementation and all gates in this document are complete.

## 2. Source-of-truth transition

The current application still reads and writes the legacy `devmate-workspace-v1` key through `src/storage.ts`. PR-B and PR-C use separate durable namespaces. Running profile migration while the legacy writer remains active is unsafe: subsequent legacy writes change the source fingerprint and create a conflict.

The cutover must therefore be an explicit application state transition, not a background side effect of mounting the App.

Required order:

1. **Preflight / read-only inspection:** identify legacy workspace bytes, current profile envelope, current task-ledger envelopes, migration marker state, transaction journals, and available snapshot slots. Do not mutate anything.
2. **Quiesce and declare intent:** pause workspace edits and wait for the App's serialized save queue to settle. Acquire the existing shared storage lock, re-read the legacy source, and abort if its fingerprint differs from preflight. Preserve the exact source bytes and verify byte-for-byte read-back. Then write and verify a separate, versioned **cutover-intent marker** before running any migration. The marker records the source fingerprint, cutover schema version, start time, and phase. This is a durable write barrier, not a success marker.
3. **Enforce the write barrier across tabs/restarts:** every legacy write path (including `saveProjectsLocked`) must check the cutover marker while holding the same shared lock and refuse writes whenever intent exists and is not safely finalized. Disabling controls in the current React view is insufficient. On startup, an intent marker forces recovery/read-only mode; the App must not fall back to the legacy writer. A malformed marker is indeterminate and blocks all writes.
4. **Prepare profiles:** while the write barrier is active, run the PR-B additive/idempotent profile migration under the shared lock. Validate the complete profile envelope and approval/revocation history. If no snapshot slot is available, stop without replacing data; retain the intent marker so restart cannot resume legacy writes.
5. **Prepare task-ledger state:** do not infer governed task fields from legacy `{id,title,done,createdAt}` records. Do not auto-convert legacy tasks into executable or approved ledger tasks. Keep legacy task data available as a read-only archive/export until an explicit, separately specified mapping flow exists.
6. **Verify new stores:** re-read every migrated profile and every existing task-ledger partition; verify project isolation, schema, policy snapshots, revision counters, and append-only event histories.
7. **Advance the marker monotonically:** under the shared lock, update the cutover marker through explicit phases (for example `intent`, `profiles-verified`, `stores-verified`, `committed`), verifying each write. Only the final `committed` phase selects durable-store mode. Phases may advance but never move backward. The final marker includes the source fingerprint and store schema versions.
8. **Post-cutover:** keep the legacy writer permanently disabled for the active application path. Keep legacy raw bytes and backups available for inspection/export. Never silently fall back to writing the old key if a durable operation fails.

**Restart rule:** no marker means legacy mode may start; an `intent`/intermediate marker means recovery/read-only mode and forward resume only; a valid `committed` marker means durable mode; an unreadable or malformed marker means indeterminate/read-only mode. Do not delete an intent marker to force a return to legacy writes. Any abort after intent must be an explicit, verified forward-reconciliation procedure that proves the legacy source is still unchanged and that no durable state was committed.

## 3. Legacy tasks: preserve, do not fabricate

The legacy task record contains only `id`, `title`, `done`, and `createdAt`. It lacks policy snapshot, risk, acceptance criteria, accountable coordinator, allowed tools/resources/actions, evidence, and recovery instructions.

Therefore:

- Keep the original legacy workspace bytes unchanged and backed up.
- Provide a read-only legacy task archive with project grouping and raw export.
- Clearly label archived tasks as **legacy / not governed / not executable**.
- Do not create a `LedgerTask` by guessing missing fields, assigning permissive actions, or marking old `done` flags as verified completion.
- A future manual promotion flow must require the owner/coordinator to supply all required fields, current project approval context, acceptance criteria, risk, allowed resources/actions, and a creation event. It must create a clean draft and must not mark the task completed merely because the legacy flag was true.

## 4. Forward-only recovery model

Recovery must preserve history and move state forward. It must never replace a current profile or task ledger with an older snapshot wholesale.

### 4.1 Recovery inputs

- Current durable envelope and its revision.
- Transaction journal and phase.
- Available raw snapshots, metadata, and fingerprints.
- Migration/cutover markers and source fingerprints.
- Current project profile, including approval and revocation history.
- Current task ledger and append-only event history.
- A validated export of the affected raw data.

Every recovery action must use a fresh expected revision (CAS). A stale revision returns conflict and requires re-inspection; it must not retry by silently using a newer revision.

### 4.2 Recovery operations

1. **Inspect:** read and classify data without mutation.
2. **Export:** produce a byte-preserving raw export plus metadata (store, project, schema, revision when parseable, timestamp, fingerprint, and export version). Verify the export payload before offering it as saved.
3. **Quarantine:** preserve the exact corrupt/unknown raw bytes in a dedicated, non-overwriting quarantine slot before any replacement. If preservation cannot be verified or capacity is exhausted, refuse replacement.
4. **Validate candidate:** parse a selected snapshot/export as untrusted input; validate its envelope, project IDs, schemas, and all cross-store relationships. A fingerprint is only stale-selection detection, not a cryptographic signature.
5. **Reconcile forward:** merge only independently valid, non-conflicting information into the current state. Preserve every current approval/revocation event and task-ledger event. Do not reduce revisions, remove records, rewrite event history, or roll back terminal task states.
6. **Commit:** apply the reconciled candidate with the current expected revision, store-specific update guard, shared lock, journal, read-back verification, and a pre-write snapshot.
7. **Verify:** read the committed state again and prove that all previously existing protected history remains present and byte-equivalent where immutable.

### 4.3 Store-specific rules

**Project profiles**
- Use `validateProjectProfilesStoreUpdate` on every recovery write.
- Approval remains bound to the exact approved profile content.
- Revocation history is append-only.
- A snapshot predating approval/revocation cannot restore the earlier status or remove history.
- Conflicting profile content or approval evidence is quarantined and escalated; do not choose one side automatically.

**Task ledger**
- Use `validateAppendOnlyLedgerUpdate` with current profiles on every recovery write.
- Existing events are immutable and must remain an exact prefix of the new event stream.
- Recovery may append explicit reconciliation events with evidence; it may not delete or rewrite old events.
- Terminal tasks remain terminal. An `indeterminate` task can move only through the existing evidence-backed reconciliation contract.
- A snapshot containing an older or conflicting task state is a candidate for comparison/export, not a replacement source.

**Generic durable journal**
- Interrupted intent is automatically reconciled only when current raw bytes exactly match the recorded before or after side.
- A third state, malformed journal, or unverifiable rollback is indeterminate. Preserve raw bytes and stop writes.
- Do not infer success from a journal phase alone; compare the exact current bytes.

## 5. User-visible recovery states

The App must expose explicit, truthful states:

| State | Meaning | Allowed actions |
|---|---|---|
| Healthy | Current durable stores validate | Normal actions within policy |
| Preflight required | Cutover or migration has not been inspected | Inspect, export |
| Cutover intent / interrupted cutover | Durable write barrier exists but the final marker is not committed | Inspect, export, resume forward; no legacy writes |
| Legacy read-only | Legacy data preserved but not promoted | View, export; no legacy writes |
| Interrupted transaction | Journal requires reconciliation | Inspect, safe retry only when exact before/after match |
| Corrupt / invalid | Stored bytes or schema fail validation | Export, quarantine; no replacement until preserved |
| Indeterminate | Storage matches neither transaction side or recovery cannot be proven | Export, inspect, owner escalation; all writes blocked |
| Snapshot full | No safe preservation slot is available | Export existing snapshots; no destructive pruning |
| Revision conflict | Another tab/session changed data | Reload, re-inspect, retry with fresh CAS |
| Cross-store mismatch | Ledger/profile relationship is invalid | Inspect/export/quarantine; no task execution or mutation |
| Recovery candidate | Snapshot/export awaits validation | Validate, compare; never one-click overwrite |

All controls must explain what will change, what is preserved, and what is blocked. Avoid labels such as “force restore”, “repair automatically”, or “migration complete” unless the exact postconditions have been verified.

## 6. Required implementation boundaries

- Keep legacy read code intact, but make every legacy write path consult the durable cutover-intent marker under the shared lock. Once intent is committed, legacy writes are blocked across tabs and restarts. Then route all App writes through one durable path; never allow dual writers.
- Reuse the existing shared Web Lock. Do not introduce nested or per-store locks.
- Use explicit expected revisions for every user-visible mutation and recovery write.
- Keep store-specific validators inside the locked update boundary.
- Do not make a generic restore API available to UI code unless the store-specific forward-only guard makes the proposed change safe.
- Do not automatically prune backups or quarantine slots.
- Keep raw export local to the browser; no external upload or provider call.
- Treat browser storage quota, lock errors, tab closure, reload, and unavailable storage as first-class failures.
- Preserve mobile usability; recovery controls must be usable on narrow screens and keyboard accessible.

## 7. Verification matrix

Before any cutover, implement tests for:

- Repeated preflight and migration are idempotent.
- Source changes between preflight and lock acquisition abort the stale plan.
- Cutover-intent marker is written and verified before migration; all legacy write APIs reject writes while intent/intermediate/committed marker exists.
- Restart at every marker phase enters the correct legacy, read-only recovery, durable, or indeterminate mode; it never re-enables the legacy writer after intent.
- Missing/empty legacy workspace still produces a valid durable profile envelope and marker ordering.
- Legacy tasks remain byte-preserved and are never auto-promoted.
- Project A recovery never changes Project B.
- Old profile snapshots cannot erase approval or revocation evidence.
- Old task snapshots cannot truncate the event prefix, reduce revision, or revert terminal tasks.
- Duplicate recovery requests are idempotent; conflicting retries return CAS conflict.
- Corrupt bytes are quarantined before replacement; no slot or failed verification blocks replacement.
- Snapshot/quarantine exhaustion never overwrites an existing slot.
- Journal intent recovery handles exact before, exact after, and third-state bytes correctly.
- Simulated failures after each storage write, during read-back, and during marker write leave a recoverable or explicitly indeterminate state.
- Browser restart/reload after every cutover step resumes safely.
- Two-tab contention and lock timeout are tested in a real browser, not only an in-memory lock stub.
- Quota exhaustion is tested in a browser; no unverified claim of browser-level recovery is made.
- App UI tests prove editing is disabled in unsafe states and no false success message is shown.

## 8. Merge and cutover gates

PR-D implementation is Sensitive. Before merge:

1. PR-C is merged and its exact-head CI/review evidence is recorded.
2. The design above is reflected in the implementation and tests.
3. Threat assessment covers data loss, cross-project leakage, stale tabs, malicious/corrupt imports, storage quota, journal tampering, and false success states.
4. Backup, raw export, quarantine, rollback boundaries, and forward-only recovery are verified.
5. Exact-head CI passes tests, TypeScript, production build, and dependency audit.
6. One independent reviewer other than the implementation author inspects the exact final SHA and recovery paths.
7. Any action that is destructive, difficult to reverse, expands sensitive permissions, creates cost, or changes owner-reserved policy stops for explicit owner approval.

Merging PR-D does not itself authorize or trigger the live migration/cutover. The cutover must be a separately observable, gated application action after the implementation is merged and verified. Do not run it against user data as part of CI.

## 9. Explicitly not included

- No task execution or AI provider integration.
- No external upload, telemetry, or cross-device sync.
- No deletion of legacy workspace keys or backup slots.
- No automatic conversion of legacy tasks.
- No forced restore or automatic destructive repair.
- No migration/cutover invocation during implementation or tests against a real user workspace.
