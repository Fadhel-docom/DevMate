# DevMate — Product Requirements

## Product
DevMate is a mobile-friendly web workspace for people building software with AI assistance and GitHub. The product name shown in the interface is **DevMate**; the GitHub account name is not part of the product identity.

## Constraints
- No paid subscriptions, API keys, or infrastructure costs before the first project withdrawal.
- No AI provider calls in Phase 1.
- Do not modify RateNest while DevMate is being established.
- Work on feature branches and merge through reviewed pull requests; never commit directly to main.
- Android browser usability is a first-class requirement.

## Phase 1 scope
- Create and switch between projects.
- Add and complete project tasks.
- A chat-shaped demo with an explicit mock response.
- Persist project/task state in the browser.
- Responsive layout for phone and desktop.
- Clear disclosure that the demo does not call an AI service.

## Out of scope
- Model training or hosting.
- Provider/API integrations.
- GitHub write access, branch creation, or pull requests from the app.
- Team accounts, billing, and paid features.

## Acceptance criteria
1. App builds successfully.
2. Project creation and switching work.
3. Task creation and completion work.
4. Data survives a page reload in the same browser.
5. Demo chat returns a clearly labelled local response.
6. No model API request or secret is required.
7. Layout remains usable on a narrow Android screen.