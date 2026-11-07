# Unified agent handoff protocol

## Purpose

This document defines a practical handoff format for ChatGPT/DevMate and any delegated coding or review agent. Its purpose is to eliminate repeated explanations, manual copying between sessions, duplicated work, and unsupported claims about what an agent has inspected.

This is an execution aid under the approved constitution. It does not grant new authority, change project scope, override owner decisions, or replace the constitution, STATUS, DECISIONS, or OPERATIONS-ROOM.

## One coordinator, one source of truth

- DevMate's designated coordinator owns task decomposition, assignment, sequencing, evidence collection, and the final handoff.
- Contributors do not create competing project plans or independent versions of the current status.
- The repository is the shared memory. Chat history is not a required dependency for resuming work.
- The authority hierarchy remains the one in constitution §10. In particular, this document is not a new policy source.
- The coordinator must give each contributor one bounded task and one exact target branch/commit. Avoid assigning multiple agents to the same files or overlapping changes.
- The owner must not be used as a message bus between agents. If a contributor cannot access a repository file, the coordinator should retrieve and provide the relevant repository reference through an available tool or mark the task blocked. Never claim that a file was delivered to another agent unless delivery is confirmed.

## Required start sequence

Every contributor must:

1. Read `docs/SESSION-START.md`.
2. Read the current `docs/STATUS.md`.
3. Read the latest relevant `docs/OPERATIONS-ROOM.md` entry.
4. Read `docs/DECISIONS.md` when the task depends on a recorded decision.
5. Consult the approved constitution and the applicable risk/authority sections.
6. Inspect the live repository, target branch, exact starting SHA, relevant PR diff, and applicable CI evidence.
7. Confirm the task's exact target SHA before editing or reviewing.

A contributor must not assume a prior agent's summary is correct when the underlying repository evidence can be checked directly.

## Task packet template

The coordinator records one task packet in the operations room or the relevant PR description. Use this compact structure:

### Identity and checkpoint
- Task ID and short title.
- Repository and project boundary.
- Target branch and base branch.
- Starting commit SHA.
- Related PR/issue links and relevant source-document SHAs.

### Outcome
- User problem being solved.
- Expected result and measurable acceptance criteria.
- Risk level: Small, Standard, or Sensitive.
- Exact files or modules expected to change.

### Authority and boundaries
- Actions explicitly permitted for this task.
- Actions explicitly excluded.
- Owner-reserved decisions, if any.
- Required backup, rollback, or recovery proof.
- Cost, data, privacy, permission, and external-service constraints.

### Verification
- Required tests, type checks, builds, audits, browser checks, or other evidence.
- Exact-head requirement: every result must identify the SHA it verifies.
- Required independent reviewer and what must be inspected.
- Evidence that is unavailable must be labelled **Unknown / not checked**, not inferred.

### Handoff
- Files changed and why.
- Commit SHA(s) and PR link.
- Checks run, exact results, and run URLs.
- Findings classified as **Verified**, **Reported, not independently verified**, **Hypothesis**, or **Unknown / not checked**.
- Remaining risks/blockers and next exact action.
- Work intentionally not performed.

## Contributor rules

### Implementation contributors
- Work only on the assigned branch and bounded scope.
- Do not change the base branch or merge a PR unless separately authorized by the approved standing delegation.
- Do not broaden permissions, add costs, disclose secrets, deploy, migrate user data, or alter owner-reserved decisions.
- Do not edit the same branch/files as another contributor unless the coordinator explicitly sequences the work.
- Keep changes focused and reversible; commit with descriptive messages.
- Do not mark a task complete until the handoff fields above are recorded.

### Review contributors
- Review the exact live PR head, not a stale SHA or a summary.
- Inspect the actual changed files and relevant downstream code.
- State which files and lines/sections were actually inspected.
- Separate blocking defects from non-blocking follow-ups.
- For each finding, provide evidence, impact, and a concrete correction.
- If a file or CI log could not be accessed, state that limitation and do not issue an approval.
- One focused independent review is the default. Re-review only when a new SHA changes relevant code or a blocking finding needs verification; do not create repetitive review cycles for unchanged code or cosmetic notes.

### Coordinator rules
- Verify contributor claims against GitHub source, exact SHAs, CI logs, and repository documents wherever possible.
- Do not treat an agent's approval, test count, or claimed file access as fact until evidence is available.
- Never forward a summary as if it were source code or a verified attachment.
- Consolidate review findings into one action list; resolve blocking issues once, then run the required checks on the resulting exact SHA.
- Keep one current state in STATUS and a chronological evidence trail in OPERATIONS-ROOM.
- Record no-change reviews and deliberate deferrals as well as code changes.
- The owner is consulted only for decisions reserved to them by the constitution or where a real ambiguity cannot be resolved from recorded authority.

## Review outcome format

Use one of these outcomes:

- **APPROVE** — exact SHA inspected; no blocking findings; applicable evidence verified.
- **APPROVE WITH FOLLOW-UP** — no blocking finding; follow-ups are explicitly non-blocking and do not violate a required gate.
- **REQUEST CHANGES** — one or more blocking defects with reproducible evidence.
- **UNABLE TO REVIEW** — required source or evidence was not accessible. This is not approval and is not a code defect finding.

Do not treat “APPROVE WITH FOLLOW-UP” as permission to skip a mandatory gate. Do not treat “UNABLE TO REVIEW” as a reason to ask the owner to manually relay files when the coordinator can retrieve them.

## Minimal handoff message

A contributor's final message should be short and machine-actionable:

```text
Task: <ID and title>
Repository / branch: <repo> / <branch>
Reviewed or changed SHA: <full SHA>
Outcome: <APPROVE | APPROVE WITH FOLLOW-UP | REQUEST CHANGES | UNABLE TO REVIEW>
Files inspected/changed: <paths>
Evidence: <checks, run URLs, exact results>
Blocking findings: <none or numbered list>
Non-blocking follow-ups: <none or numbered list>
Commit / PR: <SHA and URL, if applicable>
Next action: <one exact action>
```

## Explicit non-goals

This protocol does not create an unrestricted autonomous agent, authorize execution of project tasks, authorize production publishing, authorize legacy-data migration, authorize new costs, or change the owner's authority. Those capabilities remain gated by the approved constitution and the relevant project-specific policy.
