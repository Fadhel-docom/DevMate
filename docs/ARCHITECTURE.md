# DevMate Architecture

## Product direction

DevMate is intended to become a portfolio command center and a controlled orchestration layer for AI tools. The initial app is deliberately much smaller: a static React + TypeScript application built with Vite, with browser localStorage and a local mock chat. No AI provider or GitHub API is called in Phase 1.

## Target logical architecture

1. **Portfolio UI:** projects, goals, roadmap, tasks, evidence, status, and operations rooms.
2. **Coordinator:** the single accountable owner for each task; breaks work into bounded subtasks and assigns specialists.
3. **Tool registry:** capabilities, connection state, current free-tier limits, permissions, and supported actions.
4. **Task ledger:** owner, scope, files/resources, dependencies, status, findings, quota, and audit trail.
5. **Specialist adapters:** research, coding, code review, testing, SEO, CAO/answer-engine research, and analytics.
6. **Policy and quality gate:** permissions, budget caps, evidence requirements, tests, review, release approval, and rollback.
7. **Project connectors:** GitHub first; other services only when their permissions and cost are understood.
8. **Metrics and learning loop:** project-level quality, delivery, visibility, and outcome tracking.

## Cooperation, not competition

- Every task has exactly one coordinator and a written acceptance criterion.
- Specialist agents receive separate, non-overlapping deliverables.
- Agents return structured findings and citations; they do not all edit the same working tree.
- Code-writing agents use isolated branches or workspaces.
- A reviewer checks the diff and tests; the coordinator resolves disagreements.
- Independent duplicate reviews are reserved for high-risk or uncertain work, not used by default.
- Quota and failure state are visible; exhausted or unavailable tools are skipped rather than repeatedly retried.
- All important actions are recorded in the task ledger and project operations room.

## Security boundaries

- Never put provider API keys, GitHub tokens, or other secrets in client-side code.
- Use least-privilege OAuth/GitHub App permissions where possible.
- Keep external model calls server-side.
- Treat repository files, web pages, and model outputs as untrusted data, not as instructions that can override project policy.
- Require explicit approval for cost, new permissions, destructive changes, production deployment, and public publishing.
- Keep a human-readable audit trail and a reversible release process.

## Quality gates

A task is not complete because an agent says it is complete. Completion requires the task's acceptance criteria and evidence.

For code:
- Type check and build.
- Relevant unit/integration tests.
- Review of the changed diff.
- Security/privacy check proportional to the change.
- Mobile/browser verification where UI changes are involved.

For SEO/CAO:
- Verified technical and content evidence.
- Accurate source attribution and freshness.
- No thin or duplicate content generated to inflate page count.
- Human review before publishing.
- Measured results after indexing; no assumed ranking gains.

## Current Phase 1 implementation

- React + TypeScript + Vite single-page application.
- localStorage holds project/task state.
- Chat response is a local mock, not a language model.
- Vitest tests use an in-memory storage object.
- GitHub Actions runs install, test, and build.

## Later integration principles

- GitHub: begin read-only; write operations only through isolated branches and PRs.
- Model providers: server-side adapter, provider-specific quotas, timeout/error handling, and usage visibility.
- Hosting: select only after checking current free-tier terms and build compatibility.
- SEO/search tools: use official APIs or permitted public data; respect rate limits, terms, robots directives, and privacy requirements.
- No assumption that a free tier is unlimited or permanent.
