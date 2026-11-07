# DevMate — Product Requirements

## Product vision

DevMate is a **project operations and AI collaboration platform**. It begins as the user's private command center for managing their own web projects and the free AI tools that help build, maintain, research, and grow them. It may later become a product offered to other builders, but commercial features are not a reason to compromise the user's own quality or cost constraints.

The interface and product identity must always say **DevMate**, never the GitHub account owner name.

## Mission

Help the user move a portfolio of websites from idea to high-quality, globally competitive products through:
- A single portfolio view with project goals, status, risks, decisions, and next actions.
- Coordinated AI tools that collaborate under one task owner instead of duplicating or competing.
- Research into user needs, search demand, and competitors' strengths and weaknesses.
- Quality-controlled development, testing, releases, and maintenance.
- Ethical, evidence-based SEO and CAO/answer-engine visibility workflows.
- Measurable improvement in usefulness, trust, discoverability, and business outcomes.

## Governing law: quality before quantity

1. **Quality before quantity:** fewer excellent deliverables are better than many weak ones.
2. **Quality before publishing:** no release, indexation push, or public claim before its quality gate passes.
3. **Evidence before assumptions:** distinguish verified facts, hypotheses, and unknowns.
4. **User value before imitation:** study competitors to understand their strengths and gaps; do not copy their content, design, code, or protected assets.
5. **One task, one owner:** every task has one accountable coordinator. Other agents receive bounded roles and must return findings to that coordinator.
6. **No agent race:** agents must not independently edit the same files or repeat the same research without a documented reason.
7. **Least privilege and safe changes:** agents receive only the project access needed for their task; changes are isolated, reviewed, tested, and reversible.
8. **Cost discipline:** no paid plans, APIs, hosting, or agents before the user's first withdrawal unless the user explicitly changes this rule.
9. **No fabricated success:** tests, deployment, indexing, traffic, rankings, and revenue are reported only when measured.
10. **Continuous learning:** every release should generate a measurable learning loop, not just another feature.

## Constraints

- No paid subscriptions, API keys, or infrastructure costs before the first project withdrawal.
- Free tiers have quotas and terms that must be checked before use.
- No model provider calls in Phase 1.
- Do not modify RateNest during the DevMate foundation work.
- Work on feature branches and merge through reviewed pull requests; never commit directly to main.
- Android browser usability is a first-class requirement.
- Never expose provider secrets or GitHub credentials to browser code.

## Core product capabilities (target vision)

### A. Portfolio command center
- Register projects with goals, audience, business model, URL, repositories, and status.
- Track roadmap, milestones, decisions, blockers, releases, and performance evidence.
- Maintain a durable operations room and exact handoff for each project.
- Prioritize tasks by user impact, risk, effort, and evidence.

### B. AI tool and agent coordination
- Maintain a catalogue of available tools, capabilities, free-tier constraints, and connection status.
- Assign one lead coordinator per task.
- Delegate bounded work such as research, code review, tests, SEO audits, or content fact-checking.
- Prevent conflicting edits through file ownership, branch isolation, task leases, and explicit handoffs.
- Compare independent reviews only when the decision is important or uncertain.
- Track quota usage and stop gracefully when a free quota is exhausted.
- Require human approval for cost, secrets, permissions, destructive actions, and production releases.

### C. Quality and release governance
- Requirements and acceptance criteria before implementation.
- Automated tests, build checks, accessibility and security review where applicable.
- Peer/agent review of significant changes.
- No publishing until the project's release checklist passes.
- Rollback and incident notes for production changes.

### D. Competitive intelligence and product improvement
- Identify direct and indirect competitors for each project.
- Study competitor strengths, weaknesses, positioning, content coverage, usability, trust signals, and feature gaps using lawful public information.
- Record source URLs, dates, and confidence for findings.
- Convert verified gaps into prioritized opportunities.
- Never plagiarize or copy protected material.

### E. SEO and CAO / answer-engine visibility
- Build technical SEO checks: crawlability, indexation, canonical URLs, sitemaps, metadata, structured data, performance, and internal links.
- Build content quality workflows around search intent, original experience, evidence, helpful examples, and clear answers.
- Track visibility in search engines and AI answer surfaces where reliable data is available.
- Automate audits and recommendations first; publishing or mass content generation remains behind quality gates and approval.
- Do not promise rankings or fabricate search/AI visibility metrics.
- Confirm the user's intended meaning and scope of “CAO” before implementing a specialized optimization module.

## Development roadmap

### Phase 1 — Foundation (current)
- Responsive web app and project/task management.
- Local browser persistence.
- Clearly labelled mock chat, no model calls.
- CI, tests, production build, and Android usability.
- Operations room and quality rules.

### Phase 2 — Portfolio operations
- Multiple project records, goals, status, milestones, and handoffs.
- Durable operations-room templates.
- Prioritization and release checklists.
- No model integrations required.

### Phase 3 — AI tool registry and coordination
- Tool capability and quota registry.
- Single task coordinator and bounded specialist roles.
- Shared task ledger, ownership, conflict prevention, and audit log.
- Start with manual/approved free tools; integrate only supported services.
- No automatic multi-agent code writes until safety controls are proven.

### Phase 4 — GitHub workflow
- Least-privilege GitHub connection.
- Read-only repository analysis first.
- Branch/PR creation only after safeguards and approval.
- Tests, review, and rollback trail.

### Phase 5 — SEO/CAO and competitor intelligence
- Per-project competitor map and evidence-backed opportunity backlog.
- Technical/content SEO audits and answer-engine readiness.
- Reporting and recommendations before autonomous publishing.
- Controlled experiments with measurable outcomes.

### Phase 6 — Internal validation and possible productization
- Validate DevMate on the user's own projects, one isolated project at a time.
- Measure time saved, defect rate, release quality, discoverability, and project outcomes.
- Only after internal reliability is demonstrated, evaluate packaging DevMate for other users.
- Any billing, paid integrations, or commercial launch requires a separate business and security review.

## Phase 1 scope

- Create and switch between projects.
- Add and complete project tasks.
- Chat-shaped demo with explicit mock responses.
- Persist project/task state in the browser.
- Responsive phone and desktop layout.
- No model provider requests.

## Phase 1 acceptance criteria

1. CI installs dependencies reliably.
2. Unit tests pass.
3. Production build passes.
4. Project creation and switching work.
5. Task creation and completion work.
6. Data survives a page reload in the same browser.
7. Demo chat is clearly identified as a mock and makes no AI request.
8. Android layout is usable.
9. No secrets or paid services are required.
10. Operations room records the exact verified checkpoint.

## Out of scope for Phase 1

- Model training or provider integration.
- Autonomous multi-agent execution.
- GitHub write access from the app.
- Automated publishing or bulk content generation.
- Billing, subscriptions, and paid features.
