# DevMate session start

This file is a navigation and checklist aid. It does not create rules, change authority, or replace the approved constitution.

## Read in this order

1. Read this file and verify that its links resolve and that any commit SHA cited here or in the handoff you rely on matches the commit you are actually working from. This file currently cites no commit SHA.
2. Read [STATUS](./STATUS.md) for the current snapshot, blockers, and next task.
3. Read the latest relevant entries in [OPERATIONS-ROOM](./OPERATIONS-ROOM.md); use earlier entries as chronological history, not as a competing current-state source.
4. Read [the approved constitution](./CHARTER-AND-QUALITY-RULES.md) in full when joining for the first time, when its version changes, or when the task concerns governance. Otherwise consult the applicable sections. Version 1.0 is historical; version 1.2 is the current approved governing version following PR #23 merge commit `2f7f9c69e80863b3720c269cc33a36b33a841209`; version 1.1 remains preserved historically.
5. Read [DECISIONS](./DECISIONS.md) when the task depends on a prior decision.
6. Inspect the live repository state: current branch and exact commit, relevant open/recent PRs, changed files, and CI results for the exact commit being relied on.
7. Identify the last independently verified checkpoint and the next exact action before editing.
8. Avoid repeating completed work or bypassing previous decisions (§11): check the STATUS next action, the latest operations-room entries, DECISIONS, and open and recently merged PRs. If a task appears to be done already, verify it and record the verification instead of redoing it.

## Source-of-truth hierarchy

The hierarchy is defined by constitution §10; this page does not reorder it:

1. The owner's latest explicit, recorded decision for owner-reserved matters.
2. The approved constitution.
3. `docs/DECISIONS.md`.
4. `docs/STATUS.md`.
5. `docs/OPERATIONS-ROOM.md`.
6. `docs/SESSION-START.md` as navigation only.

If sources conflict, stop the affected action. Identify the exact conflicting statements and their sources, then resolve using §10. Ask the owner only when the hierarchy cannot resolve the conflict. Never silently choose an older handoff over a newer owner decision.

## Before editing

- State the bounded task, expected outcome, and acceptance criteria.
- Identify files expected to change and the working branch.
- Check for overlapping work by another contributor; coordinate before editing the same files or branch.
- Apply the risk level and review/approval requirements in the constitution.
- Do not spend money, expose secrets, expand permissions, deploy, or modify another repository without the required owner authorization.

## During and after work

- Use a dedicated branch and focused PR; do not write directly to `main`.
- Verify the current head before relying on CI or review evidence.
- Distinguish **Verified**, **Reported, not independently verified**, **Hypothesis**, and **Unknown / not checked**.
- Do not claim a test, review, merge, or deployment occurred unless its evidence was observed.
- After every meaningful session, append an operations-room entry and update STATUS only when the current state changes.
- If a review ends with no change, still record what was reviewed, the evidence considered, and why no change was necessary (§11).
- A contributor without repository write access provides a ready-to-append handoff. The maintainer who records it identifies both the author of the handoff and the person who committed it. Do not imply that the author personally changed or committed files if they did not (§11).
- Attribute every action to the actual actor (§§11–12). If an action was executed through a connector or another account's credentials, say who executed it, under which authorization, and how GitHub displays it (for example: executed by Claude through the GitHub connector under the owner's delegation; GitHub shows the owner's account).

## Required handoff fields

The operations-room entry must include all fields required by constitution §11:

- Date/time and contributor identity.
- Assigned task and starting checkpoint.
- Exact source links and immutable commit SHA(s) for governing documents.
- What was inspected and exact files changed.
- Commit SHA and PR link, if applicable.
- Tests/checks run and observed results.
- Verified findings, reported findings, hypotheses, and unknowns.
- Problems, risks, decisions, and rationale.
- Work intentionally not performed.
- Last verified checkpoint.
- Next exact action and handoff owner.
