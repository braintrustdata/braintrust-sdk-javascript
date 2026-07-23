import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  OpenAIAgentsSpan,
  OpenAIAgentsTrace,
} from "../../vendor-sdk-types/openai-agents";

export const openAIAgentsCoreChannels = defineChannels(
  "@openai/agents-core",
  {
    onTraceStart: channel<[OpenAIAgentsTrace], void>({
      channelName: "tracing.processor.onTraceStart",
      kind: "async",
    }),
    onTraceEnd: channel<[OpenAIAgentsTrace], void>({
      channelName: "tracing.processor.onTraceEnd",
      kind: "async",
    }),
    onSpanStart: channel<[OpenAIAgentsSpan], void>({
      channelName: "tracing.processor.onSpanStart",
      kind: "async",
    }),
    onSpanEnd: channel<[OpenAIAgentsSpan], void>({
      channelName: "tracing.processor.onSpanEnd",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.OPENAI_AGENTS },
);
