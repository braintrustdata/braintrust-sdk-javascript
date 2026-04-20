import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { SpanTypeAttribute } from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { getCurrentUnixTimestamp } from "../../util";
import {
  aggregateChatCompletionChunks,
  parseMetricsFromUsage,
} from "./openai-plugin";
import { groqChannels } from "./groq-channels";
import type {
  GroqChatCompletion,
  GroqChatCompletionChunk,
} from "../../vendor-sdk-types/groq";

export class GroqPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceStreamingChannel(groqChannels.chatCompletionsCreate, {
        name: "groq.chat.completions.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { messages, ...metadata } = params;
          return {
            input: processInputAttachments(messages),
            metadata: { ...metadata, provider: "groq" },
          };
        },
        extractOutput: (result) => result?.choices,
        extractMetrics: (result, startTime) => {
          const metrics = parseGroqMetrics(result);
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateGroqChatCompletionChunks,
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(groqChannels.embeddingsCreate, {
        name: "groq.embeddings.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { input, ...metadata } = params;
          return {
            input,
            metadata: { ...metadata, provider: "groq" },
          };
        },
        extractOutput: (result) => {
          const embedding = result?.data?.[0]?.embedding;
          return Array.isArray(embedding)
            ? { embedding_length: embedding.length }
            : undefined;
        },
        extractMetrics: (result) => parseGroqMetrics(result),
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

export function parseGroqMetrics(
  result:
    | Pick<GroqChatCompletion, "usage" | "x_groq">
    | { usage?: unknown; x_groq?: unknown }
    | null
    | undefined,
): Record<string, number> {
  const metrics = parseMetricsFromUsage(result?.usage);
  const xGroq = result?.x_groq;

  if (!xGroq || typeof xGroq !== "object") {
    return metrics;
  }

  const extraUsage = "usage" in xGroq ? xGroq.usage : undefined;

  if (!extraUsage || typeof extraUsage !== "object") {
    return metrics;
  }

  const dramCachedTokens = (extraUsage as Record<string, unknown>)[
    "dram_cached_tokens"
  ];
  const sramCachedTokens = (extraUsage as Record<string, unknown>)[
    "sram_cached_tokens"
  ];

  return {
    ...metrics,
    ...(typeof dramCachedTokens === "number"
      ? { dram_cached_tokens: dramCachedTokens }
      : {}),
    ...(typeof sramCachedTokens === "number"
      ? { sram_cached_tokens: sramCachedTokens }
      : {}),
  };
}

export function aggregateGroqChatCompletionChunks(
  chunks: GroqChatCompletionChunk[],
  streamResult?: unknown,
  endEvent?: unknown,
): {
  metrics: Record<string, number>;
  output: GroqChatCompletion["choices"];
} {
  const aggregated = aggregateChatCompletionChunks(
    chunks,
    streamResult,
    endEvent,
  );
  return {
    metrics: aggregated.metrics,
    output: aggregated.output,
  };
}
