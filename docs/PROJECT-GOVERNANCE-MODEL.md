# Project Governance and Low-Pressure Autonomy Model

**Status:** implementation design for owner review; not an amendment to the approved constitution.
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
