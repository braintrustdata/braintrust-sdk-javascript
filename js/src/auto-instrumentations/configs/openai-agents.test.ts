import { describe, expect, it } from "vitest";
import { openAIAgentsCoreConfigs } from "./openai-agents";
import { openAIAgentsCoreChannels } from "../../instrumentation/plugins/openai-agents-channels";

describe("openAIAgentsCoreConfigs", () => {
  it("registers auto-instrumentation for OpenAI Agents trace processor lifecycle methods", () => {
    const lifecycleMethods = [
      ["onTraceStart", openAIAgentsCoreChannels.onTraceStart.channelName],
      ["onTraceEnd", openAIAgentsCoreChannels.onTraceEnd.channelName],
      ["onSpanStart", openAIAgentsCoreChannels.onSpanStart.channelName],
      ["onSpanEnd", openAIAgentsCoreChannels.onSpanEnd.channelName],
    ] as const;

    for (const [methodName, channelName] of lifecycleMethods) {
      expect(openAIAgentsCoreConfigs).toContainEqual({
        channelName,
        module: {
          name: "@openai/agents-core",
          versionRange: ">=0.0.14",
          filePath: "dist/tracing/processor.mjs",
        },
        functionQuery: {
          className: "MultiTracingProcessor",
          methodName,
          kind: "Async",
        },
      });

      expect(openAIAgentsCoreConfigs).toContainEqual({
        channelName,
        module: {
          name: "@openai/agents-core",
          versionRange: ">=0.0.14",
          filePath: "dist/tracing/processor.js",
        },
        functionQuery: {
          className: "MultiTracingProcessor",
          methodName,
          kind: "Async",
        },
      });
    }
  });
});
