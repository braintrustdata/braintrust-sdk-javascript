import { describe, expect, it } from "vitest";
import { claudeAgentSDKConfigs } from "./claude-agent-sdk";
import { claudeAgentSDKChannels } from "../../instrumentation/plugins/claude-agent-sdk-channels";

describe("claudeAgentSDKConfigs", () => {
  it("registers sync query instrumentation for 0.1.x", () => {
    expect(claudeAgentSDKConfigs).toContainEqual({
      channelName: claudeAgentSDKChannels.query.channelName,
      module: {
        name: "@anthropic-ai/claude-agent-sdk",
        versionRange: ">=0.1.0 <0.2.0",
        filePath: "sdk.mjs",
      },
      functionQuery: {
        functionName: "query",
        kind: "Sync",
      },
    });
  });

  it("registers export-alias query instrumentation for 0.2.x", () => {
    expect(claudeAgentSDKConfigs).toContainEqual({
      channelName: claudeAgentSDKChannels.query.channelName,
      module: {
        name: "@anthropic-ai/claude-agent-sdk",
        versionRange: ">=0.2.0",
        filePath: "sdk.mjs",
      },
      functionQuery: {
        functionName: "query",
        kind: "Sync",
        isExportAlias: true,
      },
    });
  });
});
