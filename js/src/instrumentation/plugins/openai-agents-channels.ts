import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  OpenAIAgentsSpan,
  OpenAIAgentsTrace,
} from "../../vendor-sdk-types/openai-agents";

export const openAIAgentsCoreChannels = defineInterceptor(
  "@openai/agents-core",
  {
    onTraceStart: channel<[OpenAIAgentsTrace], PromiseLike<void>>({
      channelName: "tracing.processor.onTraceStart",
    }),
    onTraceEnd: channel<[OpenAIAgentsTrace], PromiseLike<void>>({
      channelName: "tracing.processor.onTraceEnd",
    }),
    onSpanStart: channel<[OpenAIAgentsSpan], PromiseLike<void>>({
      channelName: "tracing.processor.onSpanStart",
    }),
    onSpanEnd: channel<[OpenAIAgentsSpan], PromiseLike<void>>({
      channelName: "tracing.processor.onSpanEnd",
    }),
  },
);
