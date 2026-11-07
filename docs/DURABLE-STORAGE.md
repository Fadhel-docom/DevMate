# Durable storage foundation (PR-A)

## Purpose and boundary

This document describes the generic durable I/O layer introduced by PR-A. It is a persistence primitive, not an application integration. It does not change the existing workspace storage implementation, migrate user data, or connect project profiles/task ledgers to the UI.

The legacy `devmate-workspace-v1` key, its existing backup namespace, `src/storage.ts`, and current App persistence remain unchanged. New durable stores use separate namespaced keys.

## Namespaces

For each supported store (`project-profiles` or `task-ledger`):

- Data envelope: `devmate-durable-store-v1:<store>`
- Latest transaction journal: `devmate-durable-journal-v1:<store>`
- Migration marker: `devmate-migrations-v1:<store>`
- Raw snapshots and metadata: `devmate-durable-backups-v1:<store>:<slot>` and `<slot>:meta`

Each store has at most five snapshot slots. Slots are append-only: a full namespace is not pruned automatically. Snapshot storage is separate for each store and never consumes the legacy workspace backup slots.

The envelope is schema version 1 and stores a monotonically increasing revision, update timestamp, and a projectId-keyed record map. Project IDs are validated before use. Read, write, and restore operations are project-scoped; restoring one project leaves other project records unchanged.

## Serialization and transaction protocol

All durable stores use the existing shared Web Lock name exported by `src/storage.ts`. There is one lock boundary rather than nested per-store locks, avoiding lock-order inversions with the legacy workspace layer.

A write performs the complete read-modify-write while holding that lock. The update guard receives the complete before/after project-record maps plus a read-only storage view, so a profile validator can reconstruct the complete profile stores and a ledger validator can read current profile-store bytes under the same shared lock rather than validating against stale data loaded before the write.

1. Reconcile any pending transaction journal.
2. Read and validate the current envelope and all existing project records.
3. Check an optional expected global store revision.
4. Apply the store-specific update guard, if configured, using detached copies.
5. Serialize the next envelope.
6. Persist and read-back-verify a transaction intent containing the prior and intended raw bytes.
7. Write the new envelope and verify the exact bytes by reading them back.
8. Mark the journal committed.

If a write or verification fails, the implementation attempts to restore the exact prior raw bytes and verifies the rollback. If rollback cannot be verified, it marks the transaction indeterminate where possible and refuses later reads/writes that require recovery. On restart, an unfinished intent is reconciled only when current bytes exactly match either the before or after value; any third state is treated as indeterminate and is not overwritten.

The journal is a single latest-transaction recovery record, not a long-term append-only audit log. The task ledger's own event history remains the authoritative domain audit history when PR-C connects it.

## Snapshots and migration marker

Snapshots are created only for explicit recovery boundaries: pre-migration, pre-restore, corrupt data, or future-version data. Normal writes do not create a snapshot. Each snapshot retains the original raw bytes and a fingerprint used to detect stale selection; the fingerprint is not a cryptographic integrity signature.

No automatic pruning occurs. If all five slots are occupied, snapshot creation fails without replacing older copies. Pre-migration marking requires a snapshot to be stored before the separate migration marker is written.

The migration marker distinguishes a store that has never been migrated from one whose migration was recorded. A malformed marker is reported as unreadable rather than treated as “never migrated”. The `migrateLegacyWorkspace` operation reads the legacy `devmate-workspace-v1` bytes while holding the shared lock, snapshots the raw source, runs an additive transform with the current store records and a read-only view of other store keys, commits the durable envelope, and only then writes and verifies the separate marker. If the process stops after the data commit but before the marker, the transform can be retried; PR-B/PR-C must therefore make it idempotent. If a valid marker exists but the durable data is missing, migration fails closed rather than silently treating the store as never migrated.

Snapshot restoration is deliberately fail-closed: it requires a store-specific update guard, validates the selected project record, snapshots the current envelope first, and restores only that project. Profile and ledger stores must supply their own guards; an unguarded restore is rejected.

## Integration contract for PR-B and PR-C

- PR-B must call `validateProjectProfilesStoreUpdate` from the durable write guard while the shared lock is held. Approval/revocation history must remain append-only, and approval must remain bound to profile content.
- PR-C must call `validateAppendOnlyLedgerUpdate` inside the durable write guard, use the supplied read-only storage view in both the migration transform and update guard to load and validate the current profile store under the same shared lock, then pass those current profiles for policy snapshots and cross-validation. It must not omit the `profiles` argument in a way that skips project/profile checks.
- Both integrations must use projectId-scoped calls, deterministic clocks/IDs in tests, and `migrateLegacyWorkspace` for locked legacy reads and marker sequencing. A store validator is mandatory at the integration boundary; schema-only validation outside the lock is insufficient.
- The optional `runExclusive` injection is a deterministic test seam only. Production callers must omit it so the shared Web Lock is used.

## Known limitations and follow-ups

- No App/UI integration, automatic migration, provider, network access, or cross-device sync is included.
- Real browser multi-tab contention, browser restart/crash timing, quota exhaustion in a real browser, and Android/Safari behavior have not been verified. Unit tests use deterministic in-memory storage and an injected lock runner.
- The journal retains only the latest transaction state; it is not a durable event stream. Any future audit requirement beyond the domain task ledger needs a separately designed append-only audit store.
- Storage quotas and full backup slots are surfaced as failures; there is no destructive auto-pruning.
- The schema contract does not decide every task field's mutability policy. PR-A/PR-C must explicitly decide whether objective, scope, accountable coordinator, specialist assignments, dependencies, priority, and due date are mutable after task creation.
- `allowedResources` path/glob validation is not implemented here. It must be validated at creation and again at execution, not treated as safe merely because it is a list of strings.
- Current append-only task validation compares JSON serialization for some snapshots, so array reordering is rejected; this is safe but should be documented or replaced by canonical comparison deliberately.
- The task transition guard currently validates the final appended event for a task update. PR-C must ensure intermediate appended events cannot smuggle unrelated transitions.
- Profile persistence must call `validateProjectProfilesStoreUpdate` within the same serialized write boundary.

These are explicit integration/review items, not claims that the current application already uses durable persistence.

## PR-B — project-profile persistence adapter

PR-B adds `src/profileStore.ts` as the only profile-facing adapter over the generic durable store:

- One durable record is stored per `projectId`; reads and writes are explicitly project-scoped.
- Every profile write requires the caller's expected durable-store revision. A stale revision returns a conflict instead of overwriting newer data.
- The adapter validates each record against the full profile schema and calls `validateProjectProfilesStoreUpdate` from the durable store's locked update guard, using complete before/after record maps. Approval binding and append-only revocation history therefore remain enforced inside the shared lock.
- Legacy migration is additive and idempotent. It refuses a non-array legacy payload or any rejected legacy project rather than silently migrating only a subset. It preserves the legacy workspace key and raw pre-migration snapshot.
- Raw `pre-migration` snapshots are export-only; they are not durable profile envelopes and the profile adapter refuses to pass them to envelope restoration.
- The generic durable-store ID validator rejects the full prototype-sensitive identifier set. Runtime validator results must be exactly boolean `true`; a Promise or other truthy value is not approval.

**Migration timing gate:** PR-B exposes a migration operation but does not call it from the current App. The App still writes `devmate-workspace-v1`; running migration while that legacy writer remains active would cause the source fingerprint to change and correctly produce a conflict. PR-D must coordinate the one-time migration with the App persistence cutover, stop legacy writes before the migration is marked complete, and preserve a verified rollback/export path. No automatic migration or UI integration is claimed by PR-B.

**Known availability limitation retained:** the durable envelope currently validates all existing records before a write. One invalid record can therefore block writes to otherwise valid projects. PR-B does not silently delete or quarantine invalid data; a separately reviewed, non-destructive per-project quarantine/recovery design is required before relaxing this fail-closed behavior.


### PR-B review follow-ups — restore and migration safety

- The profile adapter rejects null, arrays, and other non-object runtime payloads with an `invalid-data` result; it does not throw synchronously for a null profile.
- Restore requires the caller's expected durable-store revision. The durable layer checks it while holding the shared lock, before changing any record; stale restore attempts return `conflict`.
- Restore remains subject to the profile update guard. A snapshot that would roll back profile revision or approval/revocation history is intentionally refused; restoring older approved state must never erase newer approval or revocation evidence. A forward-compatible profile recovery workflow that preserves this history is a PR-D prerequisite and is not claimed by this adapter.
- The generic migration validates every transformed record and the store update guard before allocating a pre-migration snapshot slot. Repeated rejected attempts therefore do not consume the bounded snapshot slots. The snapshot is still persisted and verified before the durable data commit.
- The generic durable envelope revision is a store-level compare-and-swap counter. The profile validator currently receives synthetic store revisions (1 then 2) solely to satisfy its monotonic-store contract; these values are not the durable envelope revision and must not be treated as an audit or concurrency signal. The envelope revision and `expectedRevision` provide the actual durable compare-and-swap protection.


### Preliminary migration threat and recovery assessment (PR-B; not a PR-D authorization)

| Threat or failure | Existing control | Residual requirement before PR-D |
| --- | --- | --- |
| Legacy workspace changes while migration is being prepared | Source bytes are read under the shared lock; marker records a source fingerprint; later source drift returns conflict | The App's legacy writer must be stopped at a coordinated cutover; no concurrent legacy writer may remain |
| Malformed, sparse, duplicate, unsafe, or partially invalid legacy projects | Entire transform is rejected; every resulting record and locked update is validated before commit | Exercise the full legacy corpus and retain a human-readable rejection/export path |
| Process interruption after durable data commit but before marker | Retry is idempotent; unchanged records do not trigger a second data commit; marker is written only after verified data commit | Test actual browser termination/restart at each write boundary |
| Storage quota or snapshot-slot exhaustion | Snapshot is verified before data commit; no automatic pruning; failure is closed | Verify real browser quota behavior and ensure the owner can export/recover raw source bytes |
| Stale or corrupted snapshot selection | Fingerprint is checked under lock; expected durable revision is checked under lock; profile update guard remains active | Fingerprint is non-cryptographic; do not treat it as tamper-proof or authorization evidence |
| Restore would erase approval/revocation evidence or decrease profile revision | Profile update guard refuses the restore; restore requires expected durable revision | PR-D needs a forward-only recovery UX that preserves approval evidence, or an explicit owner-governed recovery procedure; rollback of approved state is not supported |

This is a preliminary engineering threat assessment, not a formal security sign-off. Migration must remain uninvoked until PR-D demonstrates the cutover, backup/export, restart recovery, and owner-visible failure handling. No migration permission is granted by this document.


## PR-D recovery design reference

The controlled application cutover and forward-only recovery requirements are specified in [PR-D-RECOVERY-DESIGN.md](./PR-D-RECOVERY-DESIGN.md). This design is not migration authorization; the legacy writer must remain unchanged until the Sensitive-level cutover gates are met.
