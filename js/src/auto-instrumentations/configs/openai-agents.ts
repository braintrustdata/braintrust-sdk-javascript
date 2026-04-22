import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { openAIAgentsCoreChannels } from "../../instrumentation/plugins/openai-agents-channels";

const lifecycleMethods = [
  ["onTraceStart", openAIAgentsCoreChannels.onTraceStart.channelName],
  ["onTraceEnd", openAIAgentsCoreChannels.onTraceEnd.channelName],
  ["onSpanStart", openAIAgentsCoreChannels.onSpanStart.channelName],
  ["onSpanEnd", openAIAgentsCoreChannels.onSpanEnd.channelName],
] as const;

export const openAIAgentsCoreConfigs: InstrumentationConfig[] =
  lifecycleMethods.flatMap(([methodName, channelName]) =>
    ["dist/tracing/processor.mjs", "dist/tracing/processor.js"].map(
      (filePath) => ({
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
      }),
    ),
  );
