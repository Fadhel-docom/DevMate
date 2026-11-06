import { describe, expect, it } from "vitest";
import { countToolsByStatus, selectAvailableTools, TOOL_REGISTRY, type ToolDefinition } from "./registry";

describe("tool registry", () => {
  it("distinguishes available, disconnected, and not-built tools", () => {
    expect(countToolsByStatus()).toEqual({
      available: 1,
      "not-connected": 3,
      "not-built": 3
    });
  });

  it("selects only capabilities backed by tools available in the app", () => {
    const selection = selectAvailableTools(["workspace.read", "repository.read", "code.test"]);

    expect(selection.tools.map((tool) => tool.id)).toEqual(["workspace-storage"]);
    expect(selection.unavailableCapabilities).toEqual(["repository.read", "code.test"]);
  });

  it("does not select a disconnected tool even when it matches the requested capability", () => {
    const selection = selectAvailableTools(["repository.read"]);

    expect(selection.tools).toEqual([]);
    expect(selection.unavailableCapabilities).toEqual(["repository.read"]);
  });

  it("reports an empty selection for an unknown-to-the-registry capability request", () => {
    const selection = selectAvailableTools(["browser.test"]);

    expect(selection.tools).toEqual([]);
    expect(selection.unavailableCapabilities).toEqual(["browser.test"]);
  });

  it("does not mutate the registry when selecting tools", () => {
    const before = TOOL_REGISTRY.map((tool) => tool.id);
    selectAvailableTools(["workspace.write", "model.generate"]);
    expect(TOOL_REGISTRY.map((tool) => tool.id)).toEqual(before);
  });

  it("can select an injected test tool without changing production registry state", () => {
    const testTool: ToolDefinition = {
      id: "test-only",
      name: "Test-only tool",
      summary: "Injected only in this unit test.",
      status: "available",
      capabilities: ["code.test"],
      boundary: "Never part of the production registry."
    };

    const selection = selectAvailableTools(["code.test"], [testTool]);
    expect(selection.tools).toEqual([testTool]);
    expect(selection.unavailableCapabilities).toEqual([]);
  });
});
