# Initial Architecture

## Phase 1
A static React + TypeScript single-page application built with Vite. Browser localStorage holds the initial project/task state. The chat response is a local mock, not a language model.

## Why this first
- Can be developed and tested without API keys or model quotas.
- Can be deployed as static assets on a free static-hosting tier, subject to current provider limits.
- Keeps Android setup lightweight: no local server is required for normal use once deployed.
- Separates the product UI from future model and GitHub adapters.

## Later boundaries
- Model provider access must be server-side; never expose provider secrets in browser code.
- GitHub integration should use a GitHub App with least-privilege permissions where practical.
- Any future code changes must be isolated to a branch and proposed by pull request.
- Re-evaluate hosting limits and free-tier terms before deployment; free usage is not assumed to be unlimited.