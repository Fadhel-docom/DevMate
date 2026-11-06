# DevMate decision log

This log records important decisions and their rationale. It does not replace or amend the approved constitution. If a decision entry conflicts with the constitution, the constitution governs; resolve conflicts using the source-of-truth hierarchy in constitution §10.

## Recording rules

- Append entries; do not delete or silently rewrite a prior decision.
- Mark a replaced entry as `Superseded by D-NNN` and add the replacement as a new entry.
- Record only decisions supported by a verifiable source: an explicit owner approval, a PR, an immutable commit, or a clearly identified operations-room record.
- Include immutable commit SHAs and direct links wherever available.
- Do not infer approval for an owner-reserved decision (§14) from silence, a general instruction, a passing CI run, or another PR's approval.
- A standing delegation recorded by the owner (for example the routine merge delegation in constitution §7) can authorize routine actions only within its stated conditions. It never covers owner-reserved decisions under §14 or PR #1. Cite the delegation and the evidence that each condition was met in the PR or operations-room entry; routine actions taken under it are recorded in STATUS and OPERATIONS-ROOM, not in this log.
- For owner-reserved decisions under constitution §14, mark the decision **Accepted** only when explicit owner approval is evidenced. A proposal or recommendation remains **Proposed**.
- If a date, rationale, or approver is not present in the source, write `Not recorded in source`; do not guess.
- Routine progress and verification belong in STATUS and OPERATIONS-ROOM, not in this decision log.
- Do not backfill historical decisions from memory or chat summaries alone. A separate evidence-based inventory is required.

## Entry template

### D-NNN — Short decision title

- Date: YYYY-MM-DD or Not recorded in source
- Status: Proposed | Accepted | Superseded by D-NNN
- Decided / approved by: name or role; evidence link
- Context:
- Alternatives considered:
- Decision:
- Rationale:
- Consequences / risks:
- References: PR link(s), immutable commit SHA(s), and operations-room entry where applicable

## Decisions

No decisions have been inventoried into this log yet. This is intentional: historical backfilling must be evidence-based and must not rely on memory or summaries alone.
