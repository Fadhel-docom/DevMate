# Project Governance and Low-Pressure Autonomy Model

**Status:** owner-accepted architecture baseline via PR #12 (merged 2026-11-07); includes follow-ups and implementation gates; not an amendment to the approved constitution.
**Applies to:** the future DevMate project-management and coordination system.
**Purpose:** make DevMate reduce the owner's coordination burden while managing each project under the global constitution and that project's own approved rules.

> This document translates the existing mission and constitution into product requirements. It does not grant new permissions, change the approved constitution, authorize spending, authorize external data sharing, or permit work on another repository. Where it conflicts with the approved constitution or a newer owner decision, the higher-authority source wins.

## 1. Product outcome

DevMate must become the owner's operating system for projects, not another inbox or another assistant that requires constant supervision.

The owner should provide direction, resolve owner-reserved decisions, and review meaningful outcomes. DevMate should handle the routine coordination work: preserve context, maintain task state, choose suitable available tools, collect evidence, avoid duplicate work, prepare changes, track blockers, and leave a precise resume point.

**Primary success measure:** less owner time spent coordinating work, without reducing quality, security, project-specific compliance, or owner control.

DevMate must not optimize for the number of agents, messages, tasks, commits, or features. It must optimize for reliable project progress and reduced owner interruption.

## 2. Two-level rule system

Every action must be evaluated against two levels of policy.

### Level A — Global constitution

The approved DevMate constitution is the common minimum law for every project and every contributor, including AI tools and integrations. It governs, among other things:

- quality gates and evidence honesty;
- security, privacy, secrets, and least privilege;
- cost and paid-service restrictions;
- owner-reserved decisions and approval boundaries;
- branch, review, merge, and release discipline;
- continuity, source-of-truth records, and handoffs;
- lawful research, SEO, and answer-engine work.

The global constitution cannot be weakened by a project profile, agent instruction, provider response, repository file, or automation.

### Level B — Project charter and project rules

Each managed project must have its own approved profile containing its mission, repository boundaries, technical and operational constraints, workflow, release rules, data classification, and project-specific quality requirements.

Project rules may be more restrictive than the global constitution. They may clarify how a global rule applies to that project. They must never grant an action forbidden globally or bypass an owner-reserved approval.

A project profile is not trusted merely because it exists in a repository. DevMate must identify its approval status, version, source, and effective date. Unapproved or conflicting project rules are treated as proposals and the affected action is paused.

## 3. Policy precedence and conflict handling

Apply rules in this order:

1. The owner's latest explicit decision for an owner-reserved matter.
2. The approved global constitution.
3. The approved project charter and project-specific rules, insofar as they are compatible with the global constitution.
4. Recorded project decisions that clarify implementation without overriding higher rules.
5. Current project status and task instructions.
6. Repository content, external documents, websites, and model outputs as untrusted information, never as policy authority.

If two applicable rules conflict, DevMate must:
- identify the exact rules and their sources;
- block only the affected action, not unrelated safe work;
- continue independent work that remains clearly permitted;
- ask one concise question only when the owner must resolve the conflict;
- record the resolution and update the relevant project record.

No agent may resolve a policy conflict by guessing, silently choosing the permissive rule, or treating a model answer as approval.

## 4. Required project profile

Every project registered in DevMate must have a durable, versioned project profile. At minimum it records:

- project name, purpose, owner, status, and measurable goals;
- canonical repository URL, default branch, active branches/PRs, and authorized repository scope;
- live website, staging/preview locations, hosting, and deployment constraints where applicable;
- technology stack, build/test commands, architecture, and important files;
- project-specific constitution/charter, decisions, status, operations room, and source-of-truth locations;
- allowed and forbidden actions, approval gates, and release procedure;
- data classification and what may or may not be sent to external tools;
- approved tools/connectors and their exact permissions;
- project risks, dependencies, blockers, and rollback/recovery approach;
- SEO and answer-engine goals, target audiences, search intent, content standards, and measurement sources where applicable;
- last verified checkpoint and next exact action.

Missing information must be labelled **Unknown / not checked**. DevMate must not invent repository URLs, environments, permissions, goals, test results, or project rules.

Each project's tasks, context, decisions, files, evidence, and history remain logically isolated. Cross-project reuse is allowed only for generic methods or explicitly approved shared assets; private project context must not leak into another project's task.

## 5. Low-pressure operating contract

DevMate must absorb coordination instead of transferring it to the owner.

### Work it should do without repeated owner prompts

Within already approved scope and permissions, DevMate should:
- read the correct project profile and current status before starting;
- identify the next safe, useful task and its dependencies;
- split work into bounded tasks with one accountable coordinator;
- select tools by verified capability, access, availability, data suitability, and quota;
- assign non-overlapping deliverables and prevent simultaneous edits to the same files;
- collect results, citations, diffs, test output, and exact commit references;
- update the task ledger, status, decisions, and chronological handoff;
- detect failures, stop unsafe retries, and use an approved fallback when appropriate;
- prepare a clear report that distinguishes completed work, evidence, blockers, and owner decisions.

### When it should interrupt the owner

Ask only when a decision is genuinely owner-reserved or when no safe permitted path exists, including:
- new costs or financial commitments;
- new or expanded sensitive permissions, credentials, or external data sharing;
- destructive or hard-to-reverse actions;
- material scope, mission, architecture, or licensing decisions;
- security-risk acceptance;
- merges or releases that require owner approval;
- unresolved conflicts between applicable rules.

Batch related owner decisions into one concise request where possible. Do not ask the owner to repeat information already recorded. Do not ask for confirmation for every routine, reversible step that is already within the approved scope.

A user-facing summary should prioritize: what changed, what was verified, what needs the owner's decision, and the next milestone. Routine internal coordination should not become a stream of notifications.

## 6. Task and agent coordination

Every task must have:
- one accountable coordinator;
- one project and policy context;
- a bounded objective and acceptance criteria;
- risk classification (Small, Standard, or Sensitive);
- permitted tools, files, and actions;
- dependencies and a deadline/priority only when meaningful;
- expected evidence and reviewer requirements;
- current status, owner, and next action.

Specialists receive separate deliverables. For example, research produces sourced findings; coding produces an isolated diff; testing produces reproducible results; review evaluates a specific immutable commit; SEO/CAO research produces evidence-backed opportunities. The coordinator consolidates results and resolves disagreement using evidence.

No task is complete because an agent says it is complete. It is complete only when its acceptance criteria and required evidence are satisfied and its durable records are updated.

Do not invoke multiple agents by default. Use the smallest team that can complete the task safely. Independent review is required where the global constitution requires it, not as repetitive ceremony for every minor action.

## 7. Tool and provider selection

The tool registry must eventually record, per provider or integration:

- provider/model/tool identity and version where available;
- demonstrated capabilities and task types it can perform;
- connection and permission state;
- supported input/output formats and repository/app access;
- data retention, training, privacy, and regional restrictions where known;
- free-tier limits, reset timing, usage, rate limits, and known costs;
- timeouts, failures, reliability observations, and approved fallback options;
- the evidence and date supporting each claim.

Tool selection must be task-specific. Prefer a capable, available, permitted tool that fits the data classification and avoids unnecessary quota use. Do not assume a free tier is unlimited or permanent. Do not send confidential project information to a provider whose handling terms are unknown or unsuitable.

Provider unavailability must not create an endless retry loop. DevMate should record the failure, try only an approved fallback, and otherwise leave the task safely queued with a clear status.

## 8. Auditability and recovery

DevMate must preserve a traceable task ledger and audit trail. Important records include:
- who/what initiated an action and under which authorization;
- project and policy versions used;
- tool/provider selected and the reason;
- files, branches, PRs, and external resources touched;
- actions attempted and their observed outcomes;
- test, review, CI, and deployment evidence;
- approvals and the exact action they authorize;
- failures, retries, fallbacks, and recovery steps.

Secrets must never be written to task logs, browser storage, source files, or model-visible records. Secret references may identify a configured secure secret by name, but must never expose its value.

Every consequential operation must have a recovery path proportionate to risk. If DevMate cannot determine whether an operation succeeded, it must report an indeterminate state rather than repeating a potentially destructive action.

## 9. Project growth work is part of project management

For websites and other discoverability-dependent projects, DevMate's responsibility is not limited to code and technical indexing.

When the project's charter includes growth, the workflow must cover:
- real user/search intent and question research;
- competitor strengths, weaknesses, and unmet needs supported by dated evidence;
- content usefulness, originality, factual accuracy, and source quality;
- technical SEO, accessibility, performance, crawlability, and internal structure;
- answer-engine visibility opportunities, using the project's explicitly defined CAO scope;
- legitimate distribution and integration opportunities;
- measurement methods, baselines, and observed outcomes.

Do not publish thin or duplicate content, manipulate signals, violate site terms, or promise rankings, traffic, citations, or revenue. Human/owner approval remains required for publication wherever the constitution or project charter requires it.

## 10. Build sequence before connecting AI providers

Do not add model providers until DevMate can reliably manage its own work without them.

### Foundation 1 — governance and project isolation
- Implement the two-level policy model and project-profile schema.
- Load and display each project's approved rules and effective version.
- Enforce conflict detection and owner-approval gates.
- Keep project records and context isolated.

### Foundation 2 — reliable project operations
- Make project/task/decision/status records durable, validated, recoverable, and auditable.
- Provide a single current-state view and chronological work log.
- Support checkpoints, dependencies, resumable tasks, and clear failure states.
- Reduce duplicate prompts and manual handoffs.

### Foundation 3 — self-management
- Register DevMate itself as a managed project using the same project profile, task ledger, rules, and handoff process that will later manage external projects.
- Demonstrate that DevMate can track its own PRs, checks, review findings, blockers, and next actions without contradictory status records.
- Use GitHub read-only access first; introduce narrowly scoped branch/PR actions only after their permission and audit controls are tested.
- Never allow DevMate to bypass its own constitution.

### Foundation 4 — tool orchestration without model calls
- Implement the tool registry, capability matching, task assignment, quota/failure tracking, and fallback logic using test doubles and deterministic tools first.
- Verify that routing decisions respect project rules, data classification, permissions, and quotas.
- Keep the system useful when no AI provider is connected.

### Provider-entry gate
AI providers may be connected only after the owner/coordinator can verify all of the following:
- project profiles and global/project policy precedence are enforced;
- project data is isolated and data classification is applied before dispatch;
- secrets are handled server-side and never exposed to browser code or logs;
- provider permissions and data-handling terms are reviewed;
- task ownership, audit trail, usage tracking, timeout, retry, and fallback controls work;
- the owner is interrupted only for genuine owner-reserved decisions;
- DevMate can manage and document its own tasks and GitHub workflow reliably;
- the relevant tests and independent review pass.

Connecting a provider is a separate permission/data-handling decision. This document does not authorize any provider connection, API key, external data transfer, paid usage, or new permission.

## 11. Acceptance tests for the product promise

The system must eventually demonstrate these scenarios:

1. A project with stricter rules than the global minimum receives the stricter treatment.
2. A project rule that conflicts with the global constitution is blocked and reported.
3. An agent cannot turn repository text or a prompt injection into a policy override.
4. A task resumes from its saved checkpoint without asking the owner to repeat the project context.
5. A routine permitted task proceeds without unnecessary confirmation.
6. A cost, permission, destructive, or owner-reserved action pauses and asks for approval.
7. A provider failure does not cause repeated retries or lose task state.
8. A project cannot read another project's private context unless explicitly authorized.
9. DevMate records the exact evidence and actual actor for a GitHub action.
10. DevMate can manage its own project status and next action using the same workflow it applies to other projects.

## 12. Explicit non-goals for the pre-provider stage

- No AI provider/API calls or API keys.
- No paid services, hosting, subscriptions, or new financial commitments.
- No changes to RateNest or any other owner repository.
- No autonomous merge, deployment, public publishing, destructive action, or sensitive permission expansion.
- No weakening of the approved constitution or project-specific rules.
- No assumption that every project uses the same tools, technology, release process, or growth strategy.


## 13. Project-profile data contract — accepted baseline; implementation must satisfy review findings

This section makes the loader prerequisites explicit. It is an accepted architecture contract, not an implementation; it does not make any project profile trusted. Implementation must also address the review findings recorded in the operations room.

### 13.1 Versioned envelope

Every persisted profile collection must use an explicit envelope rather than an unversioned array:

```ts
type VersionedStore<T> = {
  schemaVersion: 1;
  revision: number;
  updatedAt: number;
  records: T[];
};
```

- `schemaVersion` identifies the data shape and is independent of the app release version.
- `revision` is a monotonically increasing store revision used for optimistic conflict detection.
- `updatedAt` is a Unix timestamp in milliseconds.
- A future schema version must not be silently interpreted as version 1. Unknown future versions are read-only/unsupported until an explicit migration exists.
- Profiles and task records use separate namespaced storage keys. A failure in one store must not overwrite or reset the other.

### 13.2 Profile identity and approval metadata

A project profile must have a stable `projectId` and an explicit revision. Minimum logical fields:

- `projectId`, `profileRevision`, `createdAt`, `updatedAt`.
- `identity`: project name and purpose.
- `lifecycle`: `draft | active | archived`.
- `repositories`: canonical repository identifiers and the exact allowed repository scope; unknown values remain unknown, never inferred.
- `websites`, `technology`, `goals`, `governanceReferences`, `workflow`, `dataClassification`, `allowedTools`, `forbiddenActions`, `releaseRules`, `risks`, and `recoveryPlan`.
- `unknownFields` or equivalent explicit unknown markers for information not yet verified. Missing values must not be silently replaced with guesses.

Approval is separate from lifecycle. Proposed metadata:

```ts
type ProfileApproval = {
  status: "unapproved" | "approved" | "revoked";
  approvedRevision: number | null;
  evidence: {
    kind: "owner-decision" | "approved-pull-request";
    reference: string;
    commitSha: string | null;
  } | null;
  approvedAt: number | null;
};
```

Rules:
- Imported repository content, profile text, an agent, or a local checkbox cannot approve a profile.
- Approval must point to a verifiable owner decision or approved PR and the exact profile revision it covers. An approved PR qualifies only when the PR contains an explicit owner approval for that exact profile revision; a merged PR or a reviewer approval alone is not owner approval.
- Any material profile edit increments `profileRevision`; if it no longer matches `approvedRevision`, approval becomes stale and the profile returns to an unapproved state until reviewed again.
- The current app has no authentication/authorization. Therefore this metadata is an auditable record only; it must not be treated as a secure authorization mechanism. No sensitive repository action may rely on a client-side approval flag.
- Until a real authenticated owner identity and policy enforcement exist, unapproved profiles may be drafted and inspected, but must not authorize external writes, permission expansion, spending, publishing, or access to another project's private context.

### 13.3 Validation and unknown-field policy

- Validate the complete envelope and every known field at the storage boundary; never trust TypeScript types as runtime validation.
- Reject malformed identity, duplicate project IDs, invalid enum values, invalid timestamps, duplicate repository identifiers, and impossible approval combinations.
- Distinguish invalid records from unknown optional information. Unknown business facts are represented explicitly; malformed structural data is not silently accepted.
- Preserve forward-compatible extension data only inside a namespaced `extensions` object after safe recursive sanitization. Reject dangerous object keys and non-JSON values.
- Do not silently discard unknown fields that may belong to a newer schema. If the store schema is newer than the app understands, preserve the original raw payload in a backup and refuse writes until a compatible migration is available.
- Validation returns structured errors with field paths and does not mutate the source record.

### 13.4 Migration policy

- Keep the existing `devmate-workspace-v1` project-array format readable during the transition.
- First migration is additive: create project-profile records from legacy project IDs/names only, mark all imported profiles `draft` and `unapproved`, and leave legacy project/task data unchanged.
- Do not silently import legacy tasks into the new ledger during profile migration. Keep the legacy task UI/data intact until a separately tested additive task-import step is approved; when imported later, legacy tasks lacking acceptance criteria enter `draft` with an explicit `legacy-import` event and are not treated as ready work.
- Do not infer repository URLs, permissions, charters, goals, data classifications, or approval from legacy project names or task contents.
- Migration must be deterministic and idempotent: running it twice produces the same profile IDs and no duplicate records.
- Before any write, preserve the exact pre-migration payload using the existing backup/recovery mechanism. Write the new envelope to its own key, read it back, validate it, and only then record migration completion.
- On quota, lock, verification, or parse failure, retain the original legacy data and report a recoverable failure. Never mark migration complete on an indeterminate write.
- Migrations are one-way only after the new representation has been read back and verified. Do not delete the legacy source in this phase.
- Add fixture tests for empty, valid, partially malformed, corrupt, future-version, duplicate-ID, interrupted, repeated, and quota-failure migration scenarios.

## 14. Durable task-ledger contract — accepted baseline; implementation remains gated

The ledger is a separate, project-scoped record system. "Durable" in the pre-backend phase means recoverable across reloads in the same browser profile; it does not mean cloud-synced, cross-device, or server-backed storage.

### 14.1 Task record

Every task record must contain:

- Stable `taskId` and required `projectId`.
- Objective, bounded scope, acceptance criteria, risk classification, priority, and optional due date.
- One accountable coordinator; optional specialist assignments with non-overlapping deliverables.
- Dependencies expressed as task IDs in the same project unless a separately approved cross-project dependency exists.
- Explicit allowed tools, files/resources, and actions; unknown permissions remain denied.
- Policy snapshot: constitution version, project-profile revision, approval status, and applicable decision references at task start.
- State, created/updated timestamps, attempt count, checkpoint, result/evidence references, and next exact action.
- Failure/blocked reason and recovery instructions where applicable.
- Append-only event history for material state transitions and actions. Never store secrets or raw credentials.

### 14.2 State machine

Initial states:

`draft → queued → ready → in_progress → review → completed`

A task enters `queued` only after its objective, project, accountable coordinator, and minimum acceptance criteria are present. A task with missing required context remains `draft`.

Other permitted transitions:
- `ready | in_progress | review → blocked`
- `blocked → ready` only after the blocking condition is resolved and recorded.
- `ready | in_progress | review → awaiting_owner` for a genuinely owner-reserved decision.
- `awaiting_owner → ready` only after the exact decision is recorded.
- `queued | ready | blocked → cancelled` with a reason.
- `in_progress → failed` only after a bounded attempt ends without a safe recovery.
- `in_progress → indeterminate` when an external operation may have succeeded but evidence is insufficient.
- `review → ready` when review requires bounded rework; the finding and next action must be recorded.
- `indeterminate → ready | failed | cancelled` only after reconciliation establishes the actual outcome and records supporting evidence; never retry directly from an unresolved indeterminate state.

Terminal states are `completed`, `cancelled`, and `failed`; `indeterminate` is a hold state requiring reconciliation before retry. A task cannot become completed merely because an agent reports success: acceptance criteria and evidence must be checked.

### 14.3 Checkpoints, events, and recovery

- Each task has a current checkpoint with a monotonic sequence number, timestamp, concise summary, completed criteria, remaining work, and references to immutable artifacts/commits.
- Every consequential action records intent before execution and observed outcome afterward.
- Action outcomes are `planned | started | succeeded | failed | indeterminate`; retries require an idempotency key or an explicit reconciliation step.
- A failed write must not erase the last known-good checkpoint.
- Recovery restores the last verified checkpoint and preserves the failed attempt/event history.
- The task snapshot may be compacted for performance, but the append-only event history must retain the audit facts needed to explain decisions and actions.

### 14.4 Project isolation and queries

- Every task, event, checkpoint, artifact reference, and decision link is scoped by `projectId`.
- All reads and writes require an explicit project context; there is no implicit global task query.
- Cross-project task references and context sharing are denied by default. Generic reusable methods may be shared without copying private project data.
- Tests must prove that a task query for one project cannot return another project's tasks, events, files, or private context.
- A missing or unapproved project profile cannot silently inherit another project's permissions or rules.

### 14.5 Storage and concurrency

- Use a separate versioned task-ledger store and the existing lock/backup/verify patterns; do not overload the legacy project array with the event ledger.
- Validate before writes, serialize same-store writes, compare the expected revision, read back and validate the new value, and retain a recoverable backup.
- A storage lock unavailable, revision conflict, quota error, or failed read-back must leave the task in a recoverable non-completed state.
- The current browser-local implementation must disclose its limits: clearing browser data can remove the ledger, and no cross-device sync exists.

## 15. Implementation gates derived from the accepted architecture baseline

Before a profile loader or task ledger is implemented:
1. Owner acceptance of the architecture baseline is recorded in D-001 and PR #12. This does not grant implementation-specific permissions or bypass sensitive-change approval gates.
2. The profile and task schema definitions are converted into runtime validators and versioned fixtures.
3. Approval metadata is treated as evidence, not authorization, until authentication and policy enforcement exist.
4. Migration and recovery tests pass, including interrupted writes and future schema versions.
5. Project-isolation tests prove that no private task context crosses project boundaries.
6. The implementation uses only local deterministic operations and existing dependencies; no providers, external connectors, paid services, API keys, or new permissions are introduced.
