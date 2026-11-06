import { describe, expect, it } from "vitest";
import { countToolsByStatus, selectAvailableTools, TOOL_REGISTRY, type ToolCapability, type ToolDefinition } from "./registry";

describe("tool registry", () => {
  it("distinguishes available, disconnected, and not-built tools", () => {
    expect(countToolsByStatus()).toEqual({
      available: 1,
      "not-connected": 0,
      "not-built": 6
    });
  });

  it("marks a mixed request unsatisfied when any required capability is unavailable", () => {
    const selection = selectAvailableTools(["workspace.read", "repository.read", "code.test"]);

    expect(selection.tools.map((tool) => tool.id)).toEqual(["workspace-storage"]);
    expect(selection.unavailableCapabilities).toEqual(["repository.read", "code.test"]);
    expect(selection.satisfied).toBe(false);
  });

  it("does not select a disconnected tool even when it matches the requested capability", () => {
    const disconnectedTool: ToolDefinition = {
      id: "disconnected-test-tool",
      name: "Disconnected test tool",
      summary: "Its adapter exists but no connection is configured.",
      status: "not-connected",
      capabilities: ["repository.read"],
      boundary: "Test fixture only."
    };

    const selection = selectAvailableTools(["repository.read"], [disconnectedTool]);
    expect(selection.tools).toEqual([]);
    expect(selection.unavailableCapabilities).toEqual(["repository.read"]);
    expect(selection.satisfied).toBe(false);
  });

  it("reports a known capability as unavailable when no production tool implements it", () => {
    const selection = selectAvailableTools(["browser.test"]);

    expect(selection.tools).toEqual([]);
    expect(selection.unavailableCapabilities).toEqual(["browser.test"]);
    expect(selection.satisfied).toBe(false);
  });

  it("marks a request satisfied only when every requested capability is available", () => {
    const selection = selectAvailableTools(["workspace.read", "workspace.write"]);
    expect(selection.unavailableCapabilities).toEqual([]);
    expect(selection.satisfied).toBe(true);
  });

  it("does not treat an empty capability request as executable work", () => {
    const selection = selectAvailableTools([]);
    expect(selection.tools).toEqual([]);
    expect(selection.unavailableCapabilities).toEqual([]);
    expect(selection.satisfied).toBe(false);
  });

  it("keeps production tool identifiers unique and capability lists non-empty", () => {
    const ids = TOOL_REGISTRY.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOOL_REGISTRY.every((tool) => tool.capabilities.length > 0)).toBe(true);
  });

  it("freezes the registry, each tool, and nested capability lists at runtime", () => {
    expect(Object.isFrozen(TOOL_REGISTRY)).toBe(true);
    expect(TOOL_REGISTRY.every((tool) => Object.isFrozen(tool))).toBe(true);
    expect(TOOL_REGISTRY.every((tool) => Object.isFrozen(tool.capabilities))).toBe(true);
  });

  it("freezes selection results and the arrays they return", () => {
    const selection = selectAvailableTools(["workspace.read", "repository.read"]);

    expect(selection.tools.map((tool) => tool.id)).toEqual(["workspace-storage"]);
    expect(selection.unavailableCapabilities).toEqual(["repository.read"]);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.tools)).toBe(true);
    expect(Object.isFrozen(selection.unavailableCapabilities)).toBe(true);
    expect(selection.tools.every((tool) => Object.isFrozen(tool))).toBe(true);
    expect(() => (selection.tools as ToolDefinition[]).push(TOOL_REGISTRY[0])).toThrow(TypeError);
    expect(() => (selection.unavailableCapabilities as ToolCapability[]).push("code.test")).toThrow(TypeError);
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
    expect(selection.satisfied).toBe(true);
  });
});
