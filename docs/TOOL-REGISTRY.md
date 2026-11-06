# DevMate Tool Registry — Foundation

**Status:** first in-app inventory and deterministic capability-selection foundation. This is not a live integration of external services.

## Purpose

Give DevMate an honest, inspectable inventory of tools before building orchestration. A tool is selectable only when its capability is actually available inside the DevMate application. A connector available to an external assistant does not automatically become available to DevMate.

## Readiness states

- **Implemented (runtime-gated):** an adapter is implemented in the current app. This does not guarantee every operation will succeed at runtime; callers must still handle browser, storage, lock, and safety-gate failures.
- **Not connected:** an adapter exists, but no authorized connection is configured.
- **Not built yet:** the adapter or execution environment does not exist.

A status must not be upgraded because a plan exists, a service is available in another application, or a contributor says it should work. Update a status only with implementation and verification evidence.

## Initial inventory

| Tool | Current state | Boundary |
|---|---|---|
| Workspace storage | Implemented (runtime-gated) | Browser-local project/task persistence only; not cloud sync or repository storage |
| GitHub read-only | Not built yet | No GitHub API adapter exists inside DevMate; external assistant connectors are separate |
| Test and build runner | Not built yet | Requires a trusted, isolated execution environment and resource limits |
| Code review | Not built yet | No review engine or model provider is connected |
| Browser testing | Not built yet | No browser automation adapter inside the app |
| Research and SEO/CAO | Not built yet | No research adapter exists inside the app; future findings require dated sources |
| AI model provider | Not built yet | No provider adapter exists; any future connection is gated by privacy, server-side secret handling, quota, fallback, and owner approval |

## Selection contract

src/tools/registry.ts defines the typed registry and selectAvailableTools. Its optional registry argument is a test seam for deterministic fixtures; production callers must use the default frozen registry, not pass caller-controlled tool definitions:

1. A task declares the capabilities it requires.
2. The selector returns only entries whose state is available and that cover at least one requested capability.
3. Every missing capability is returned as unavailable.
4. The result's `satisfied` flag is true only when the request contains at least one capability and **all** requested capabilities are available. An empty request returns `satisfied: false` (no work was specified). Callers must check this flag and must not treat a non-empty tool list as proof that a multi-capability task is executable.
5. The registry is descriptive and deterministic. It does not make network calls, execute code, invoke an AI model, or grant permissions.

The current selector is a foundation for future routing, not an orchestrator. It is not yet used to dispatch work. The workspace-storage entry describes existing in-browser project/task persistence; it does not expose a new privileged execution interface.

## Security and governance boundaries

- No API keys, tokens, provider SDKs, new permissions, or external calls are introduced.
- No external project or repository is connected.
- No provider data-handling terms are assumed.
- GitHub write operations, test execution, and public publishing are out of scope.
- Tool selection cannot override the global constitution or a project's stricter rules.
- Unknown capability, unavailable tool, or unresolved policy must fail closed and be reported honestly.

## Acceptance checks for this foundation

- Every tool has a unique stable ID, a non-empty capability list, a readiness state, and an explicit boundary.
- Registry entries and nested capability lists are frozen at runtime.
- Selection returns only tools marked available and reports `satisfied: true` only when all required capabilities are covered.
- Missing capabilities are surfaced rather than guessed or routed to a disconnected tool.
- Registry counts, selection behavior, invariants, and immutability have unit tests.
- The registry is not exposed in the public workspace. An owner-only dashboard is deferred until real authentication and authorization exist; no UI component or styling is shipped for it in this slice.
- No external API calls or AI provider calls occur.

## Next implementation sequence

1. Keep this registry accurate and independently reviewed.
2. Design GitHub read-only integration as a separate adapter, with least privilege, explicit connection state, project scope, and auditable reads.
3. Add a safe test/build runner only after its isolation, quotas, timeout, and artifact handling are designed.
4. Add independent review and browser-test adapters with evidence outputs.
5. Add research/SEO/CAO integrations only after source, terms, rate limits, and data classification are established.
6. Consider AI provider adapters only after the provider-entry gate in the current constitution's data-classification, security, and owner-approval requirements (§§5–6 and 14) are met and the owner approves the separate connection/data-handling decision.

Do not call Phase 1 complete because this inventory exists. It is one small foundation slice.