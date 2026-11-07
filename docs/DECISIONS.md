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

No earlier historical decisions have been backfilled. The following decision is recorded from its explicit PR evidence.


### D-001 — Approve the Project Governance and Low-Pressure Autonomy architecture baseline

- Date: 2026-11-07
- Status: Accepted
- Decided / approved by: Project owner; explicit approval recorded in PR #12 description and in the owner instruction to merge PR #12 if ready and compliant.
- Context: DevMate needs a two-level governance model and a reliable project/task foundation before adding provider connections.
- Alternatives considered: Continue with the prior informal project context; or adopt the documented project-governance model as the implementation baseline.
- Decision: Approve the architecture proposal in PR #12 as the implementation baseline, subject to constitution v1.1 and the normal independent-review/merge gates.
- Rationale: Establish project isolation, policy precedence, owner-approval boundaries, task accountability, auditability, recovery, and a staged pre-provider implementation sequence.
- Consequences / risks: This approval does not amend constitution v1.1 and does not authorize provider connections, API keys, external data sharing, costs, new permissions, public publishing, or work on other repositories. Implementation remains gated by review and verification.
- References: [PR #12](https://github.com/Fadhel-docom/DevMate/pull/12); latest approved design head `4ae15ba5de1b2af75e1dbb48073ce73dbf60ca4f`; owner approval recorded in PR description.
