export type ToolStatus = "available" | "not-connected" | "not-built";

export type ToolCapability =
  | "workspace.read"
  | "workspace.write"
  | "repository.read"
  | "pull-request.read"
  | "checks.read"
  | "code.test"
  | "code.build"
  | "code.review"
  | "browser.test"
  | "web.research"
  | "seo.research"
  | "answer-engine.research"
  | "model.generate";

export interface ToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ToolStatus;
  readonly capabilities: readonly ToolCapability[];
  readonly boundary: string;
}

const toolDefinitions = [
  {
    id: "workspace-storage",
    name: "Workspace storage",
    summary: "Read and save projects and tasks in this browser.",
    status: "available",
    capabilities: ["workspace.read", "workspace.write"],
    boundary: "Uses the existing browser storage layer. Data is local to this browser; this is not a GitHub or cloud backup."
  },
  {
    id: "github-reader",
    name: "GitHub read-only",
    summary: "Inspect repositories, files, pull requests, and check results.",
    status: "not-built",
    capabilities: ["repository.read", "pull-request.read", "checks.read"],
    boundary: "No GitHub API connection exists inside the DevMate app. A connector available to an external assistant is separate and is not inherited by this app."
  },
  {
    id: "test-runner",
    name: "Test and build runner",
    summary: "Run project tests, type checks, and production builds.",
    status: "not-built",
    capabilities: ["code.test", "code.build"],
    boundary: "The browser app has no trusted code-execution environment. A runner must be designed with isolation and resource limits before activation."
  },
  {
    id: "code-review",
    name: "Code review",
    summary: "Inspect diffs for correctness, maintainability, and security risks.",
    status: "not-built",
    capabilities: ["code.review"],
    boundary: "No review engine or model provider is connected. The registry must not present a review as completed without evidence."
  },
  {
    id: "browser-testing",
    name: "Browser testing",
    summary: "Exercise real user flows, responsive layouts, and accessibility.",
    status: "not-built",
    capabilities: ["browser.test"],
    boundary: "No browser automation adapter is available inside DevMate."
  },
  {
    id: "research",
    name: "Research and SEO/CAO",
    summary: "Research user intent, competitors, search visibility, and answer-engine opportunities.",
    status: "not-built",
    capabilities: ["web.research", "seo.research", "answer-engine.research"],
    boundary: "No research connector is connected to the app. Findings will require dated sources and must not be fabricated."
  },
  {
    id: "ai-provider",
    name: "AI model provider",
    summary: "Delegate bounded research, coding, and review tasks to approved models.",
    status: "not-built",
    capabilities: ["model.generate", "code.review"],
    boundary: "Intentionally disabled. Provider terms, privacy, server-side secrets, quotas, and the owner approval gate must be satisfied first."
  }
] as const satisfies readonly ToolDefinition[];

/** Freeze both the registry entries and their nested capability arrays at runtime. */
export const TOOL_REGISTRY: readonly ToolDefinition[] = Object.freeze(
  toolDefinitions.map((tool) =>
    Object.freeze({
      ...tool,
      capabilities: Object.freeze([...tool.capabilities])
    })
  )
);

export interface ToolSelection {
  readonly tools: readonly ToolDefinition[];
  readonly unavailableCapabilities: readonly ToolCapability[];
  /** True only when every requested capability is backed by an available tool. */
  readonly satisfied: boolean;
}

/**
 * Returns only tools that are actually available in this app.
 * Planned or disconnected integrations are never selected for execution.
 */
export function selectAvailableTools(
  required: readonly ToolCapability[],
  registry: readonly ToolDefinition[] = TOOL_REGISTRY
): ToolSelection {
  const tools = registry.filter(
    (tool) => tool.status === "available" && required.some((capability) => tool.capabilities.includes(capability))
  );
  const unavailableCapabilities = required.filter(
    (capability) => !tools.some((tool) => tool.capabilities.includes(capability))
  );
  return { tools, unavailableCapabilities, satisfied: unavailableCapabilities.length === 0 };
}

export function countToolsByStatus(registry: readonly ToolDefinition[] = TOOL_REGISTRY): Record<ToolStatus, number> {
  return registry.reduce(
    (counts, tool) => {
      counts[tool.status] += 1;
      return counts;
    },
    { available: 0, "not-connected": 0, "not-built": 0 }
  );
}
