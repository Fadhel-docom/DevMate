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

A write performs the complete read-modify-write while holding that lock:

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

The migration marker distinguishes a store that has never been migrated from one whose migration was recorded. A malformed marker is reported as unreadable rather than treated as “never migrated”. PR-B/PR-C must make migration idempotent and only mark completion after the new data has been durably committed.

Snapshot restoration is deliberately fail-closed: it requires a store-specific update guard, validates the selected project record, snapshots the current envelope first, and restores only that project. Profile and ledger stores must supply their own guards; an unguarded restore is rejected.

## Integration contract for PR-B and PR-C

- PR-B must call `validateProjectProfilesStoreUpdate` from the durable write guard while the shared lock is held. Approval/revocation history must remain append-only, and approval must remain bound to profile content.
- PR-C must call `validateAppendOnlyLedgerUpdate` inside the durable write guard, pass the current profile store for cross-validation, and preserve the append-only task event history. It must not omit the `profiles` argument in a way that skips project/profile checks.
- Both integrations must use projectId-scoped calls, deterministic clocks/IDs in tests, and explicit migration markers. A store validator is mandatory at the integration boundary; schema-only validation outside the lock is insufficient.
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
