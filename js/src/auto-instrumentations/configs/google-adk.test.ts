import { describe, it, expect } from "vitest";
import { googleADKConfigs } from "./google-adk";
import { googleADKChannels } from "../../instrumentation/plugins/google-adk-channels";

describe("googleADKConfigs", () => {
  it("should export an array of InstrumentationConfig", () => {
    expect(Array.isArray(googleADKConfigs)).toBe(true);
    expect(googleADKConfigs.length).toBeGreaterThan(0);
  });

  it("should have configs for Runner.runAsync, BaseAgent.runAsync, and FunctionTool.runAsync", () => {
    const runnerConfigs = googleADKConfigs.filter(
      (c) => c.channelName === googleADKChannels.runnerRunAsync.channelName,
    );
    const agentConfigs = googleADKConfigs.filter(
      (c) => c.channelName === googleADKChannels.agentRunAsync.channelName,
    );
    const toolConfigs = googleADKConfigs.filter(
      (c) => c.channelName === googleADKChannels.toolRunAsync.channelName,
    );
    expect(runnerConfigs.length).toBe(3);
    expect(agentConfigs.length).toBe(3);
    expect(toolConfigs.length).toBe(3);
  });

  it("should target @google/adk module", () => {
    for (const config of googleADKConfigs) {
      expect(config.module.name).toBe("@google/adk");
    }
  });

  it("should use versionRange >=0.1.0 for all configs", () => {
    for (const config of googleADKConfigs) {
      expect(config.module.versionRange).toBe(">=0.1.0");
    }
  });

  it("should use Sync kind for Runner.runAsync (async generator)", () => {
    const runnerConfigs = googleADKConfigs.filter(
      (c) => c.functionQuery.className === "Runner",
    );
    expect(runnerConfigs.length).toBe(3);
    for (const config of runnerConfigs) {
      expect(config.functionQuery.kind).toBe("Sync");
      expect(config.functionQuery.methodName).toBe("runAsync");
    }
  });

  it("should use Sync kind for BaseAgent.runAsync (async generator)", () => {
    const agentConfigs = googleADKConfigs.filter(
      (c) => c.functionQuery.className === "BaseAgent",
    );
    expect(agentConfigs.length).toBe(3);
    for (const config of agentConfigs) {
      expect(config.functionQuery.kind).toBe("Sync");
      expect(config.functionQuery.methodName).toBe("runAsync");
    }
  });

  it("should use Async kind for FunctionTool.runAsync", () => {
    const toolConfigs = googleADKConfigs.filter(
      (c) => c.functionQuery.className === "FunctionTool",
    );
    expect(toolConfigs.length).toBe(3);
    for (const config of toolConfigs) {
      expect(config.functionQuery.kind).toBe("Async");
      expect(config.functionQuery.methodName).toBe("runAsync");
    }
  });

  it("should target correct file paths per class", () => {
    const runnerPaths = googleADKConfigs
      .filter((c) => c.functionQuery.className === "Runner")
      .map((c) => c.module.filePath);
    expect(runnerPaths).toContain("dist/esm/runner/runner.js");
    expect(runnerPaths).toContain("dist/esm/index.js");
    expect(runnerPaths).toContain("dist/cjs/index.js");

    const agentPaths = googleADKConfigs
      .filter((c) => c.functionQuery.className === "BaseAgent")
      .map((c) => c.module.filePath);
    expect(agentPaths).toContain("dist/esm/agents/base_agent.js");
    expect(agentPaths).toContain("dist/esm/index.js");
    expect(agentPaths).toContain("dist/cjs/index.js");

    const toolPaths = googleADKConfigs
      .filter((c) => c.functionQuery.className === "FunctionTool")
      .map((c) => c.module.filePath);
    expect(toolPaths).toContain("dist/esm/tools/function_tool.js");
    expect(toolPaths).toContain("dist/esm/index.js");
    expect(toolPaths).toContain("dist/cjs/index.js");
  });
});
