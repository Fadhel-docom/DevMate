# DevMate autonomy roadmap proposal
**Prepared:** 2026-11-11  
**Status:** Draft proposal only. This document does not authorize implementation, account creation, provider connection, permission grant, migration, deployment, or paid services.

## 1. Recommendation

Adopt a **cloud-orchestrated, checkpoint-first architecture** as the target for DevMate:

- Cloudflare Workers + Workflows for the API and durable orchestration.
- Cloudflare D1 as the authoritative project/task/run/checkpoint ledger for the pilot, subject to confirming the Free plan is suitable for the intended personal production use.
- Groq Free API as the first external model candidate, subject to account-level ZDR verification.
- Cloudflare Workers AI (GLM-4.7-Flash) as a second free model candidate.
- A least-privilege GitHub App for selected repositories.
- GitHub Actions standard hosted runners for isolated checkout, tests, browser tests, and bounded repository work.

This is a recommendation, not an approved architecture. It better fits the stated goal—work continues when the browser is closed, projects stay isolated, providers can fail over, and runs resume from a durable checkpoint—than making browser storage the long-term authority.

PR #37's IndexedDB CAS design remains useful as local-cache/offline work and as evidence about browser concurrency. Do not adopt it as the final authoritative store until it is compared against this cloud-first proposal. The S2-04/S2-16 results show why localStorage must not remain the authority for concurrent agent runs.

**Promise “no lost progress”, not “never pauses”.** When all eligible free providers are unavailable or over quota, DevMate must pause in `WAITING_FOR_PROVIDER` with its checkpoint intact. It must never silently upgrade, incur charges, or replay an uncertain external action.

## 2. Current baseline

The repository is still a local React/Vite application. The Tool Registry says model-provider integration, a DevMate GitHub integration, a code runner, browser testing, and research tools are not implemented. The current chat is not yet an autonomous model agent.

- PR #32 and #33 are merged; the shipped app keeps the cutover controller out of the production import graph and provides read-only recovery/export.
- PR #39's isolated Chromium CAS harness is merged. It proves the harness detects double-success/lost-update mutants; it is not an application storage implementation.
- PR #35 exact-head CI passed on 2026-11-11. S2-04 and S2-16 remain failing findings; independent review is pending.
- PR #36 has an S2-16 root-cause investigation, but its branch needs a clean rebase and one factual wording correction.
- PR #37 is a draft architecture proposal; its owner decisions are not approved.
- PR #34 accessibility work is still on a pre-PR-D base and needs a safe rebase.
- R1 stale-writer prevention remains unresolved. Live cutover and migration remain prohibited.

The governance documents define Project Profiles and a Task Ledger, but these are not implemented as a durable execution backend.

### Binding constraints

1. No paid plan, prepaid credit, billing method, or automatic upgrade.
2. No provider key or repository credential in browser code, source files, logs, or model prompts.
3. No provider connection or GitHub permission expansion until the owner approves the specific gate.
4. No private repository access until the owner selects it and approves exact permissions.
5. No live migration, restore, deletion, cutover, or deployment until the safety and owner gates pass.
6. High-risk operations remain approval-gated; the agent may prepare a PR but must not silently deploy or merge a risky change.

## 3. Target architecture

```text
React UI (thin client; no provider secrets)
          |
          v
Cloudflare Worker API
          |
          +---- D1: projects / tasks / runs / checkpoints / events / approvals
          |
          +---- Workflows: durable orchestration, retries, waits and resume
          |
          +---- Provider adapters
          |        +---- Groq Free API (primary candidate)
          |        +---- Workers AI GLM-4.7-Flash (fallback candidate)
          |
          +---- GitHub App (selected repositories only)
                       |
                       v
              GitHub Actions runner
              checkout -> patch -> test -> report
                       |
                       v
                 PR / CI result
```

**Authority boundaries**
- D1 is authoritative for project profiles, task/run state, checkpoint versions, provider attempts, approvals, and event history.
- Workflows coordinates execution; it is not the only permanent record. Its free-plan state/log retention is limited, so D1 retains long-term checkpoints and history.
- GitHub is authoritative for source code, branches, commits, PRs, and CI results. D1 stores references and commit SHAs, not a second copy of repository contents.
- The browser is a UI/cache only. It must not decide whether a step committed or a GitHub side effect occurred.
- Models propose structured actions; a deterministic executor validates schema, permissions, path allowlists, expected commit SHA, and idempotency before executing.

A browser service worker is event-driven and may be stopped by the browser when idle; it is not a reliable always-on scheduler. IndexedDB can support local caching/offline drafts, but it does not provide background execution, multi-project scheduling, or provider failover by itself.

Cloud-first does **not** make legacy localStorage data safe to migrate automatically. R1 remains a separate owner-approved migration gate. Keep the existing read-only export/archive path until an import procedure is approved.

## 4. Free provider qualification

The first pair worth testing is Groq Free plus Cloudflare Workers AI Free. Neither is connected.

| Candidate | Verified position | Limitation | Decision |
|---|---|---|---|
| **Groq Free API** | Official API, tool-use support for selected models, explicit Free tier. Its data terms say inputs/outputs are not used for model training; ZDR is available. | Free limits are model- and organization-specific. The public rate-limit page separates Free limits from the Developer table; do not copy Developer limits as Free limits. Verify the actual account limits and ZDR setting before use. No guaranteed uninterrupted capacity. | First candidate. Public/synthetic tests first; private-code use only after ZDR is visibly enabled and the owner accepts processing terms and region. |
| **Cloudflare Workers AI — GLM-4.7-Flash** | Listed model supports function/tool calling, has a 131K context window, and is marked ZDR. Workers AI includes a 10,000-neuron daily free allocation. | Daily neuron allocation is shared; input/output consume different neuron amounts. Model availability/free status can change. It shares Cloudflare infrastructure with the proposed backend, so a Cloudflare-wide outage pauses both orchestration and this fallback. | Second candidate. Qualify with synthetic/public tasks, then request owner approval for private-code processing. |
| **Gemini API Free** | A real free API tier exists for eligible models. | Google Free-tier terms allow content to be used to improve products and may involve human review. Do not send confidential code, credentials, private project data, or personal data on this tier. | Public/synthetic-only optional provider; not in private-code failover. |
| **ChatGPT Free / Claude Free consumer sites** | Interactive consumer products exist. | They are not sanctioned machine-to-machine APIs. Anthropic's consumer terms prohibit automated bot/script access except as permitted through its API. API access is separate and must not be assumed free. | Do not automate consumer browser UIs. Use official APIs only. |

### Provider policy

1. Start with Groq Free and Workers AI GLM-4.7-Flash as the two adapters to qualify.
2. Use official API endpoints and model IDs only.
3. Check current free quotas in each account dashboard; do not hard-code Developer-plan limits as Free limits.
4. Require ZDR or an owner-approved equivalent before sending private repository content.
5. Classify each project `PUBLIC`, `PRIVATE`, or `RESTRICTED`; a provider that fails a class's data policy is not a fallback for that class.
6. If all eligible providers are unavailable or over quota, persist the checkpoint and pause. Never switch to a paid tier.
7. Re-qualify model availability, terms, quotas, and tool-call support before changing model IDs.

This is model-provider failover, not multi-cloud disaster recovery. Workers AI shares Cloudflare with the proposed orchestrator. A Cloudflare-wide outage pauses execution; D1 remains the checkpoint authority and Workflows resumes when service recovers.

## 5. No-cost execution options

| Option | Role | Free limits / constraints | Decision |
|---|---|---|---|
| **Cloudflare Workers Free** | API, authentication checks, webhooks, provider routing. | 100,000 requests/day; 10 ms CPU per request; five Cron triggers/account. CPU-heavy work must be split or delegated. | Control plane only. |
| **Cloudflare Workflows Free** | Durable orchestration, step retries, waits, and resume. | 3,000 steps/day; 1,024 steps/instance; 10 ms CPU/step; bounded persisted state; three-day retention for completed state/logs. D1 stores long-term history. | Recommended low-volume personal orchestrator. |
| **Cloudflare D1 Free** | Persistent project/task/run/checkpoint ledger. | 5 million rows read/day, 100,000 rows written/day, 5 GB total storage, and 10 databases. A database is single-threaded; Cloudflare estimates about 1,000 simple 1 ms queries/second, but 100 ms queries yield about 10/second. Exceeding daily limits returns errors; Cloudflare describes Free as a prototype/experiment tier. | Recommended pilot source of truth; start with one indexed database partitioned by project ID. Confirm Free-plan suitability before relying on it for personal production use. |
| **Workers AI Free** | Second model endpoint without a separate provider key. | 10,000 neurons/day; model-specific input/output neuron costs apply. Quota exhaustion pauses the run. | Recommended fallback candidate. |
| **GitHub Actions standard hosted runners** | Ephemeral checkout, build, test, browser test, patch validation, PR creation. | Standard runners are free for public repositories; each job maxes at six hours. Private repositories on GitHub Free include 2,000 minutes/month and 500 MB of artifact storage; excess can be billed unless a hard spending stop is configured. | Use the existing public DevMate repository first. No private-repo execution until owner approval and a hard spending stop. |
| **Browser tab / Service Worker** | UI and small event-driven tasks. | Browser may terminate idle service workers; event lifetime is bounded. Not an always-on scheduler. | Not the execution backend. |

Cloudflare Queues are not required for the first pilot because Workflows already provides durable orchestration. If a separate queue is later justified, its Free plan has a 10,000-operations/day allowance and 24-hour message retention. D1 must still be the source of truth; a queue message is only a wake-up signal.

**No-cost rule:** no Cloudflare Paid plan, GitHub larger runner, paid model, prepaid credit, or billing method. If a free quota is exhausted, the run becomes `WAITING_FOR_PROVIDER` or `WAITING_FOR_EXECUTOR`. No automatic upgrade. Private-repository Actions use requires an explicit hard spending limit before enablement.

## 6. Checkpoint and failover contract

“Resume from the same checkpoint” means resume from durable task state, not from a provider's hidden conversation or private reasoning.

Each checkpoint stores:
- `projectId`, `taskId`, `runId`, schema/state/plan versions.
- Repository ID, branch, base commit SHA, patch/artifact references and hashes.
- Completed step IDs, current step, validated outputs, tool results, and next permitted action.
- Provider attempts/error classes, but no API keys or secrets.
- Policy version, Project Profile version, allowed tools/paths, and approval gates.
- Stable idempotency keys for every external side effect.

The checkpoint must not depend on a provider-specific chat ID. A fallback receives the persisted plan, current step, relevant artifacts, and tool results. It may produce a different response, but cannot silently re-plan or repeat completed steps.

Run states: `QUEUED`, `PLANNING`, `EXECUTING`, `VERIFYING`, `COMPLETED`, `WAITING_FOR_PROVIDER`, `WAITING_FOR_EXECUTOR`, `WAITING_FOR_APPROVAL`, `FAILED`, `CANCELLED`.

- Retry/fail over on transient 429, 5xx, timeout, connection failure, or model unavailability using bounded backoff and cooldown.
- Do not fail over around authentication errors, revoked permissions, policy/safety refusals, malformed requests, or owner approval requirements.
- Permit one bounded schema-repair attempt; validate output before any tool action.
- A model call with an uncertain timeout is recorded as `UNKNOWN`; retrying may consume quota twice, but no external action has run yet.
- For an uncertain GitHub commit/branch/PR response, query GitHub using the stable idempotency key and reconcile before retrying. Never blindly repeat it.
- Completed steps are immutable. If all providers are unavailable, save the checkpoint and pause.

## 7. Dependency-ordered roadmap

### M0 — Close evidence and choose the storage authority
Finish independent review/rebase of current evidence PRs; correct the S2-16 root-cause wording; keep PR #37 Draft; rebase PR #34 accessibility work after the storage sequence. Decide Cloudflare D1/Workflows versus IndexedDB as the authoritative store. Recommendation: Cloudflare-first. R1 and legacy migration remain separately gated.

**Exit:** owner records the architecture decision. No migration in M0. Cloudflare's D1 Free plan is explicitly guaranteed for prototyping/experimentation; before M5, confirm its terms and reliability are suitable for the intended personal production use. If not, stop rather than silently move to Paid.

### M1 — Cloudflare durability proof (synthetic data only)
Create an isolated Worker + Workflow + D1 proof with synthetic projects/tasks. Implement versioned D1 CAS, append-only events, and checkpoints before/after every step. No GitHub App, provider key, real project data, or production UI.

Tests: 100 concurrent writes to one run version yield exactly one CAS winner; kill/restart between steps resumes the same checkpoint without repeating completed steps; quota errors pause safely; D1 retains long-term history beyond Workflow retention; no secrets appear in browser bundles/logs.

**Exit:** exact-head tests pass; no paid resource and no production data.

### M2 — Provider-neutral task/checkpoint engine
Implement the run state machine, Project Profile, Task Ledger, provider-attempt records, schema validation, and idempotency/reconciliation using mock providers.

Test: provider A returns 429 after step 3; provider B resumes step 4; steps 1–3 do not repeat; an uncertain GitHub response is reconciled without a duplicate PR.

**Exit:** repeatable mock failover/resume tests pass. No provider connected.

### M3 — Qualify the free model pair
Add Groq and Workers AI adapters behind a disabled feature flag. Test tool calling, schema validation, context limits, model quality, 429 handling, and quota reporting with public/synthetic prompts.

Test: Groq 429 → Workers AI continues from the same checkpoint; both unavailable → `WAITING_FOR_PROVIDER`; malformed output never triggers a tool action; provider keys never appear in browser assets/logs/D1.

**Exit:** model-specific free quota and ZDR verified; owner approves external processing. No private code before this gate.

### M4 — GitHub integration and sandbox runner
Create a GitHub App restricted to DevMate. Start read-only. Add workflow dispatch and write permissions only after the read-only integration passes. Use standard GitHub Actions runners for checkout, tests, browser tests, and bounded patch application.

Controls: minimum permissions; trusted-branch dispatch; no provider keys in runner; short-lived task token; no `pull_request_target` execution of untrusted code; pinned third-party Actions; path allowlists; timeouts; artifacts without secrets.

**Exit:** app reads repo state, dispatches one bounded test job, receives and reconciles its result. Owner separately approves write permissions before branch/PR creation.

### M5 — One-project DevMate pilot
One Project Profile, one active run, one task at a time. Start with low-risk documentation and test tasks. The agent can plan, prepare a patch, run tests, and open a PR. No auto-merge, deployment, deletion, or permission changes.

**Exit:** at least 30 consecutive bounded tasks complete or pause without losing checkpoints; injected provider failures resume; no duplicate GitHub side effects; CI is reproducible; owner accepts the operating report.

### M6 — Multi-project expansion
Add projects one at a time, each with an owner-approved GitHub App installation and Project Profile. Start with one active run per project and global concurrency 1.

**Exit:** two-project isolation tests prove no cross-project state, secrets, artifacts, branches, or checkpoints. Each additional repository is explicitly selected by the owner.

### M7 — Autonomous low-risk operations
Allow pre-approved low-risk steps end-to-end. Keep architecture changes, migrations, security/permission changes, paid services, destructive actions, production deployment, and high-impact merges behind explicit approval.

**Exit:** prompt-injection, permission-boundary, recovery, failover, and independent-review gates pass. Do not claim autonomy until the full lifecycle is verified.

## 8. Acceptance and stop conditions

The pilot is not accepted unless:
- No acknowledged step is lost; every run resumes from the last committed checkpoint.
- Retries cannot duplicate branches, commits, PRs, restores, or other external side effects.
- At least two qualified providers continue a public/synthetic run from the same checkpoint; private-data failover only if both pass privacy review.
- Free quota exhaustion pauses the run; no paid fallback.
- Project state, tools, secrets, and artifacts are isolated.
- GitHub App permissions are limited to owner-selected repositories and approved operations.
- Exact-head CI, browser tests, and independent review accompany every implementation PR.
- Untested browsers, unsupported providers, missing quotas, and known failures remain visible.

Stop and return to the owner if a second provider cannot meet privacy/free-tier requirements, a service requires a payment method or paid upgrade, legacy data is ambiguous, or broader GitHub permissions are needed.

## 9. Owner decisions required before implementation

| Decision | Recommendation | Required before |
|---|---|---|
| Storage authority | Cloudflare D1/Workflows for task/run/checkpoint; IndexedDB optional local cache. | M1 |
| Cloudflare resources | Free Worker, Workflows, D1, Workers AI only; no Paid plan or billing method. | M1 |
| Provider processing | Groq Free with ZDR and Workers AI GLM-4.7-Flash; public/synthetic test data first. | M3 |
| GitHub integration | GitHub App restricted to DevMate; read-only first, write later by separate approval. | M4 |
| Legacy data | Keep export/archive; no migration until R1 procedure and owner-run import are accepted. | Any migration |
| Other projects | Select and approve each repository individually. | M6 |
| Paid fallback | None; any later paid option requires a new owner decision. | Any paid use |

## 10. Explicit non-goals

This proposal does not connect providers, create accounts/keys/secrets, grant permissions, deploy, migrate localStorage data, approve PR #37's IndexedDB design, enable private-repository access, authorize auto-merge, or promise uninterrupted execution.

## 11. Official sources checked 2026-11-11

**Providers and data**
- [Groq rate limits](https://console.groq.com/docs/rate-limits) — Free limits are model/organization-specific; verify the Free dashboard, not the Developer table.
- [Groq Your Data](https://console.groq.com/docs/your-data), [Groq Services Agreement](https://groq.com/terms-of-service/), [tool use](https://console.groq.com/docs/tool-use), and [structured outputs](https://console.groq.com/docs/structured-outputs).
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) and [GLM-4.7-Flash model card](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/).
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) and [Gemini API terms](https://ai.google.dev/gemini-api/terms).
- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms).

**Execution and persistence**
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), and [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/).
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/).
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/) — optional queue quotas and retention.
- [GitHub spending budgets](https://docs.github.com/en/billing/managing-your-billing/setting-up-budgets-to-control-spending) — hard-stop configuration before any private-repository overage.
- [GitHub Actions hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [usage limits](https://docs.github.com/en/actions/reference/limits), and [billing](https://docs.github.com/en/actions/concepts/billing-and-usage).
- [MDN Service Worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

Quotas, model availability, free-plan terms, and privacy settings can change. Re-check official pages and account dashboards immediately before any owner-approved connection or deployment.

---

## Original owner task packet (preserved as historical context)

The following text is the original brief as received. Its status statements reflect the time it was written; the provider research and roadmap work are now recorded in the proposal above.

# Roadmap request to the coordinator — autonomous multi-project management with provider failover

**Status:** task packet / request. It is not a roadmap, not an approval, and does not authorize any provider connection, key, cost, merge or release.
**Date:** 2026-11-09
**Requested by:** repository owner (product owner), in the Claude conversation of 2026-11-09.
**Written by:** Claude, via the GitHub connector under the owner's delegation (GitHub shows the owner's account).
**Addressed to:** ChatGPT coordinator (default coordinator, constitution §4). Claude is the independent reviewer of the result.
**Starting checkpoint:** `feature/phase-1-foundation` at `00a59793f0452cd7ee0d8a27ffb0ef3bbac78bc4`. The newest S2-16 records are on the PR #37 branch (see "Known state" below).

## 1. The owner's objective

A self-operating system that manages all of the owner's projects and uses free AI tools one after another, so that when one tool stops the next continues from the same point, without stopping and without going back. The global rules and each project's own rules are binding.

## 2. Rules this request is bound by (read, not summarised from memory)

- Constitution v1.2 (`docs/CHARTER-AND-QUALITY-RULES.md`): §2 quality before quantity; §4 roles, tool choice by demonstrated capability, quota governance; §5 no new cost until the owner records the first qualifying withdrawal; §6 data classification, no secrets, other repositories out of scope without a specific authorization; §7 branch/PR/merge rules and the PR #1 hold; §10-§12 source of truth, session protocol, evidence labels; §14 owner-reserved decisions.
- `docs/PROJECT-GOVERNANCE-MODEL.md`: §2-§3 two-level rules (global constitution, then each project's approved profile; a project rule can be stricter, never weaker); §5 low-pressure contract; §7 tool and provider selection; §10 build sequence and the **provider-entry gate**; §12 non-goals before providers.
- Owner constraints given in this conversation: no direct change to `main`; no PR merge by Claude; no storage change, migration or cutover; no production deployment; no Google Jules; no invented evidence or unrun tests; no new phase without the owner's approval; priority is control of the project, not more drafts.

**Consequence to state plainly:** the objective in section 1 requires connecting AI providers. Under the provider-entry gate (governance model §10) and §12 that is a separate, owner-reserved permission and data-handling decision that has not been made. This request therefore asks for a roadmap that *reaches* that point in verified steps. It does not start it.

## 3. What the coordinator is asked to produce

One roadmap proposal, as a single new file `docs/ROADMAP-PROPOSAL.md` in one docs-only PR based on `feature/phase-1-foundation`. Do not edit overlapping files on other branches; do not create parallel proposals.

Required content:

1. **Milestones in dependency order, starting from the current checkpoint** (not from the beginning). For each: goal, risk level (Small / Standard / Sensitive), acceptance criteria, evidence required, prerequisite PRs, and the owner-reserved decisions it needs.
2. **The critical path to the objective**, at least covering: reliable durable checkpoints (S2-16 and R1 must be resolved or explicitly bounded first); task ledger and project-profile integration; tool registry; a provider-adapter interface exercised only with test doubles; the failover state machine; the provider-entry gate checklist; the first real provider connection (as an owner decision, not a step taken).
3. **Failover semantics written precisely.** What "continue from the same point" means technically: checkpoint contents, idempotent steps, how an in-flight call whose outcome is unknown is recorded and resolved (compare the committed / not-committed / unknown classification used in the S2-16 design), what is never replayed, how endless retry loops are prevented (governance model §7), and the honest limits of the guarantee.
4. **Answers, with evidence and sources, to these open architecture questions** (each labelled Verified / Reported / Hypothesis / Unknown; verify current free-tier terms rather than relying on memory, constitution §4-§5):
   - Where does autonomous execution run? A browser-only app cannot act while closed. Which free, no-cost execution options exist, with what limits?
   - Which "free AI tools" can be used programmatically under their own terms? (Hypothesis to verify: consumer chat interfaces generally offer no sanctioned automation interface, while free-tier API access with keys does.)
   - How are API keys handled server-side at no cost without exposing secrets in browser code, logs or the repository? Any secret handling is owner-reserved.
   - Which data classes (Public / Internal / Confidential) may go to which provider, given unknown retention and training terms (§6)?
   - How does each of the owner's other projects get its own approved Level B project profile and rules before DevMate acts on it? Other repositories remain out of scope until a specific authorization (§6); RateNest is not touched. This repository is public, so project names and personal details of the owner's other projects must not be written here.
5. **A short list of owner decisions, batched** (governance model §5): only genuinely owner-reserved items, each with options and a recommendation.
6. **What is intentionally not in the roadmap**: provider connection, keys, paid services, autonomous merge or release (governance model §12).

## 4. Process

- Coordinator drafts the PR (Draft). Claude performs one independent review of the exact head and returns one verdict. The author does not review their own proposal (§8 Gate D).
- The roadmap becomes effective only with the owner's explicit approval, recorded in `docs/DECISIONS.md`. It affects mission/scope, which is owner-reserved (§14). No phase starts on the strength of a draft.
- Use the repository as the shared source of truth. The owner must not be asked to carry information between assistants.

## 5. Known state the coordinator must start from (Verified by Claude on 2026-11-09 through the GitHub API)

- `feature/phase-1-foundation` `docs/STATUS.md` and `docs/OPERATIONS-ROOM.md` stop at 2026-11-07. The newest records are on separate unmerged branches; the PR #37 branch (`design/indexeddb-cas-store`) is the most complete. See operations-room entry 71 on that branch.
- S2-16 is unresolved in the application path. The S2-16 v4 design draft is not in the repository and could not be recovered (entry 71, blocker B1). v3 is archived and unapproved. No design version is approved.
- Six evidence figures quoted by v3 are not traceable to a committed artifact (entry 71, finding 4).
- Open: #1 (hold), #32, #33 (Draft), #34, #35, #36, #37, #39 (Draft). Merged: #38. Do not merge #32-#37 as a batch.
- No AI provider is connected; the tool registry is an inventory only (`docs/TOOL-REGISTRY.md`).

## 6. Claude's non-binding input (Hypothesis, offered for the coordinator to accept or reject with evidence)

Likely first steps, because everything toward failover depends on reliable checkpoints and one trustworthy status record: (1) reconcile STATUS and OPERATIONS-ROOM across the stacked branches; (2) obtain v4 and settle the S2-16 design with the owner's decisions; (3) clear the review queue (#39, #34, #32/#33/#35); (4) only then provider-free orchestration with test doubles. The coordinator may order this differently if evidence supports it.

## 7. Session record (constitution §11)

- Inspected: constitution v1.2 in full; governance model §2-§12 headings and §2, §3, §5, §7, §10-§12 text; PRD roadmap; `docs/TOOL-REGISTRY.md` and `docs/ARCHITECTURE.md` by heading and keyword only.
- Changed: this file only, on branch `docs/roadmap-request` (base `00a59793...`). No tests or builds run. No change to `main`, no merge.
- Not performed: contacting ChatGPT directly (no channel exists for that from this session; the coordinator picks this up from the repository), any provider research, any code.
- Operations-room entry: not appended to avoid adding a further divergent copy of `docs/OPERATIONS-ROOM.md`; to be folded into the log when the coordinator reconciles the branches.
- Next exact action: ChatGPT coordinator reads this file and opens the roadmap-proposal PR. Handoff owner: ChatGPT coordinator.

