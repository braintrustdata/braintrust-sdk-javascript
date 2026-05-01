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
    const expectedConfigs = [
      "dist/tracing/processor.mjs",
      "dist/tracing/processor.js",
    ]
      .flatMap((filePath) =>
        lifecycleMethods.map(([methodName, channelName]) => ({
          channelName,
          module: {
            name: "@openai/agents-core",
            versionRange: ">=0.0.14",
            filePath,
          },
          functionQuery: {
            className: "MultiTracingProcessor",
            methodName,
            kind: "Async",
          },
        })),
      )
      .sort((left, right) =>
        `${left.module.filePath}:${left.functionQuery.methodName}`.localeCompare(
          `${right.module.filePath}:${right.functionQuery.methodName}`,
        ),
      );

    expect(
      [...openAIAgentsCoreConfigs].sort((left, right) =>
        `${left.module.filePath}:${left.functionQuery.methodName}`.localeCompare(
          `${right.module.filePath}:${right.functionQuery.methodName}`,
        ),
      ),
    ).toEqual(expectedConfigs);
  });
});
