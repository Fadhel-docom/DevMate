# DevMate Operations Room

> Shared source of truth for the user, ChatGPT, and Claude. Read this file and `docs/STATUS.md` before proposing or making changes.

## 1. Mission

Build **DevMate**, a useful, mobile-first, web-based AI coding workspace with GitHub integration.

The goal is not to train a model. The goal is to create a practical assistant that helps the user understand, plan, modify, test, and manage software projects through a web interface, with safe GitHub branch and pull-request workflows.

The first real-world validation target may be RateNest, but RateNest is strictly out of scope until the user explicitly authorizes a separate, isolated test. Do not modify RateNest as part of DevMate setup.

## 2. Product identity and links

- Product name shown in the app: **DevMate**.
- GitHub repository: https://github.com/Fadhel-docom/DevMate
- Current implementation PR: https://github.com/Fadhel-docom/DevMate/pull/1
- Current working branch: `feature/phase-1-foundation`
- Base branch: `main`
- Live deployed app URL: **Not available yet**. Do not describe the GitHub repository URL as a deployed website.
- The GitHub account/owner name must not be used as the product brand in the app UI, title, or future public-facing domain.

## 3. Non-negotiable constraints

1. Zero new costs before the user's first withdrawal: no paid subscriptions, paid APIs, paid hosting, or paid agents.
2. Free tiers may have limits and can change; never assume unlimited usage.
3. Do not use OmniRoute for DevMate v1.
4. Do not expose API keys, GitHub tokens, or secrets in browser code, commits, screenshots, or logs.
5. Never push directly to `main`. Work on feature branches and submit pull requests.
6. Do not modify RateNest or any other repository unless the user explicitly authorizes it.
7. Keep setup light and Android-friendly. Do not require heavy local development on the user's phone.
8. Never claim tests, builds, deployment, or browser checks passed unless their results were actually observed.
9. Preserve a clear handoff after each work session: files changed, commits, checks, decisions, blockers, and next exact action.
10. If Claude and ChatGPT disagree, record both explanations and ask the user to decide when the choice affects scope, cost, security, or architecture.

## 4. Collaboration protocol

At the start of every session, each assistant must:
- Read this file and `docs/STATUS.md`.
- Inspect the current PR, branch, latest commits, and CI results before editing.
- State the current verified checkpoint and the proposed next action.
- Avoid redoing work already recorded here.

Before making code changes:
- Review the relevant files and explain the cause of the issue.
- Prefer the smallest reversible change.
- Keep changes on the existing feature branch for this Phase 1 PR unless a separate branch is agreed.
- Do not merge or close the PR without the user's approval.

After making changes:
- Record changed paths and commit SHA(s).
- Run or inspect the relevant automated checks.
- Distinguish verified results from assumptions and unverified items.
- Update `docs/STATUS.md` and this operations room with the next exact action.

### Division of work

- **User:** product owner; approves scope, costs, permissions, merges, and major decisions.
- **Claude:** independent code review, root-cause analysis, test/build review, and proposed fixes. Claude should report findings before changing code unless the user explicitly asks it to implement.
- **ChatGPT:** maintain this shared handoff, cross-check findings, coordinate GitHub work, and implement only agreed changes.
- Both assistants should inspect each other's commits and avoid simultaneous conflicting edits.

## 5. Product plan

### Phase 1 — Foundation (current)

Goal: prove the product's core workflow without any model API or cost.

Scope:
- Mobile-first DevMate web interface.
- Create and switch between projects.
- Add and complete coding tasks.
- Local browser persistence.
- Demo chat with an explicitly labelled mock response.
- No external model calls.
- Basic automated tests and CI.
- Deployment only after checks and user review.

Acceptance criteria:
1. CI installs dependencies reliably.
2. Unit tests pass.
3. Production build passes.
4. User can create and switch projects.
5. User can add and complete tasks.
6. Project/task data survives a browser reload.
7. Demo chat is clearly identified as a mock and makes no AI request.
8. Android browser layout is usable.
9. No secrets or paid services are required.

### Phase 2 — Safe GitHub project connection

Only after Phase 1 acceptance:
- Explore GitHub App integration with least-privilege permissions.
- Start read-only: list repositories, inspect files, summarize issues and changes.
- Later, if approved, create feature branches and pull requests.
- Never give the browser a raw GitHub token.

### Phase 3 — Model provider integration

Only after a working, useful GitHub workflow:
- Compare genuinely free/available model options and their current limits.
- Use a server-side provider adapter/router.
- Add explicit usage limits, provider failure handling, and clear user-visible status.
- No API key or paid plan without explicit approval.
- Do not assume a free Claude Code subscription or OAuth route is available.

### Phase 4 — Real project validation

- Use an isolated copy or branch of RateNest only after explicit user approval.
- Test a bounded task and review every diff.
- Require tests and a PR; never push directly to RateNest main.
- Measure whether DevMate saves time and produces reliable changes before expanding scope.

### Phase 5 — Deployment and improvement

- Compare free static hosting options and verify current free-tier terms.
- Publish only after build, tests, and mobile checks pass.
- Use a DevMate product identity and a suitable domain only if it can be done without violating the zero-cost rule.
- Add monitoring and progress reports without introducing paid dependencies.

## 6. Current implementation checkpoint — 2026-11-05

Repository was created by the user as a public GitHub repository with MIT license and a README. The first implementation was committed to `feature/phase-1-foundation` and submitted as draft PR #1 targeting `main`.

Initial files added:
- `package.json`
- `index.html`
- `tsconfig.json`
- `vite.config.ts`
- `src/main.tsx`
- `src/App.tsx`
- `src/styles.css`
- `src/storage.ts`
- `src/storage.test.ts`
- `.github/workflows/ci.yml`
- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/STATUS.md`
- `docs/OPERATIONS.md`

Implemented in source (not yet accepted as verified):
- Responsive React/Vite/TypeScript interface branded DevMate.
- Project creation and switching.
- Task creation and completion.
- Browser localStorage persistence.
- Local mock chat; no model provider integration.
- Initial persistence unit tests.
- GitHub Actions workflow.

PR facts:
- PR: https://github.com/Fadhel-docom/DevMate/pull/1
- Title: Phase 1: establish DevMate web workspace
- Draft: yes
- Target: `main`
- At initial submission: 14 files changed, 364 additions, 0 deletions.

## 7. Current blocker: CI failed before tests/build

The user supplied GitHub Actions screenshots showing both the push and pull_request workflow runs failed.

Visible error:
`Error: Dependencies lock file is not found ... Supported file patterns: package-lock.json, npm-shrinkwrap.json, yarn.lock`

Likely cause based on the visible log:
- The workflow uses `actions/setup-node@v4` with `cache: npm`.
- The repository does not currently contain a `package-lock.json`.
- setup-node therefore fails while preparing the npm cache, before dependency installation, tests, or production build.

Important:
- This is the confirmed visible blocker.
- It is **not yet evidence of an application code failure**.
- Tests and production build have not been verified.
- Do not simply mark CI as fixed or tests as passing.

### Required next investigation (Claude should lead review)

1. Inspect `.github/workflows/ci.yml` and `package.json` on `feature/phase-1-foundation`.
2. Confirm the setup-node cache behavior and the absence of a lockfile.
3. Recommend one minimal reproducible solution:
   - Prefer generating and committing a valid npm `package-lock.json`, then use `npm ci`; or
   - If there is a reason not to commit a lockfile, remove npm caching and use a deliberate install command.
4. Check whether `vite.config.ts` imports `defineConfig` from `vitest/config` and whether package versions/scripts are consistent.
5. Inspect the app and persistence tests for TypeScript/build/test issues.
6. Implement the smallest agreed correction on the feature branch.
7. Confirm both PR and push CI checks pass, then report the exact run links and commit SHA.
8. Do not merge PR #1 until the user reviews the result and approves.

## 8. Questions that require product-owner approval

Do not decide these silently:
- Whether Phase 1 should remain a local-only demo until deployed.
- Which free hosting provider to use after checking current limits.
- Which model provider, if any, to integrate later.
- Whether/when to authorize isolated RateNest validation.
- Any change that introduces cost, new permissions, or external data access.

## 9. Session handoff template

Append a dated entry after each meaningful session:

### YYYY-MM-DD — Assistant / contributor
- **Starting checkpoint:**
- **What I inspected:**
- **Changes made:**
- **Commit SHA(s):**
- **Checks run and exact results:**
- **Unverified items:**
- **Blockers / decisions needed:**
- **Next exact action:**
- **Files another assistant must read first:**

---

**Current next action:** Claude independently reviews the CI failure and the Phase 1 code, then returns a short diagnosis and proposed minimal fix. No merge, no deployment, and no RateNest changes yet.
