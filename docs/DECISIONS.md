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


### D-001 — Adopt the project-governance and low-pressure autonomy model as the Phase 1 architecture baseline

- Date: 2026-11-07
- Status: Accepted with follow-ups
- Decided / approved by: Repository owner; explicit approval was given in the project conversation before PR #12 was merged. The PR body also records the approval; GitHub's shared-account attribution does not independently authenticate the conversational instruction.
- Context: DevMate needs a project-scoped governance model, versioned profiles, a durable task ledger, explicit approval boundaries, and a staged path to self-management.
- Alternatives considered: Continue implementation without a common project-governance baseline; defer the profile/task contracts.
- Decision: Accept `docs/PROJECT-GOVERNANCE-MODEL.md` as the architecture baseline through PR #12, with the non-blocking follow-ups documented in the review record and subsequent implementation gates.
- Rationale: The model preserves constitution v1.1 as the highest authority, keeps approval evidence distinct from authorization, and explicitly gates provider integrations.
- Consequences / risks: The acceptance does not approve every future implementation detail, storage mechanism, provider connection, cost, external data transfer, permission expansion, deployment, or action on another repository. Sensitive implementation PRs still require their own independent review and any owner-reserved approval.
- References: [PR #12](https://github.com/Fadhel-docom/DevMate/pull/12); merge commit `f38475485268d212eddc906ee06f762648070d37`; approved constitution v1.1 `50126a159961b71faf88025a8695cb7e734d63b7`.


### D-002 — Standing merge delegation without repeated owner prompts

- Date: 2026-11-07
- Status: Accepted
- Decided / approved by: Repository owner; explicit instruction in the project conversation on 2026-11-07: «سجل هذا القانون لا تعود لي في كل مرة تريد دمج طالما انه استوفي كل الشروط لا يكون هذا عمل روتيني اي شيء يستوفي الشروط قم به و استمر في التقدم». GitHub shared-account attribution does not independently authenticate the conversational instruction.
- Context: Repeatedly asking the owner to approve each merge after all required conditions are met creates unnecessary coordination and delays autonomous project management.
- Alternatives considered: Continue requesting per-PR confirmation for every merge; extend standing delegation with explicit sensitive-work safeguards.
- Decision: Contributors may merge a PR without another owner prompt when all applicable constitution conditions, quality gates, exact-head verification, and independent review pass. This includes bounded, reversible data-format and migration changes when the sensitive-level requirements are met; it is not a command to merge when a gate is uncertain or an owner-reserved decision applies.
- Rationale: Owner time should be reserved for genuine decisions, not repeated authorization of work already covered by the standing delegation.
- Consequences / risks: The delegation does not waive PR #1's hold, owner-reserved decisions, new costs, secret disclosure, sensitive permission expansion, destructive or difficult-to-reverse actions, material security-risk acceptance, licensing decisions, mission/scope changes, or unauthorized production/public release. If any required gate fails, block only the affected action and continue safe independent work.
- References: Owner instruction dated 2026-11-07; proposed constitution amendment v1.2 in this PR; reviewed PR head `96ace96d3d6434e7f12352ea675a50e7065dce61` (superseded by the correction commits in this same PR). The final merge SHA must be added to the status/operations record after merge.
