import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { aggregateChatCompletionChunks } from "./openai-plugin";
import { groqChannels } from "./groq-channels";
import { extractGroqCompletionInput, parseGroqMetrics } from "./groq-span-data";
import {
  interceptGroqBatchTraceBind,
  interceptGroqBatchTraceCollect,
  interceptGroqBatchTraceFail,
  interceptGroqBatchTraceStart,
} from "./groq-batch-instrumentation";
import type {
  GroqChatCompletion,
  GroqChatCompletionChunk,
} from "../../vendor-sdk-types/groq";

export class GroqPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      groqChannels.batchesStartTrace.intercept(interceptGroqBatchTraceStart),
      groqChannels.batchesBindTrace.intercept(interceptGroqBatchTraceBind),
      groqChannels.batchesCollectTrace.intercept(
        interceptGroqBatchTraceCollect,
      ),
      groqChannels.batchesFailTrace.intercept(interceptGroqBatchTraceFail),
    );

    this.unsubscribers.push(
      traceStreamingChannel(groqChannels.chatCompletionsCreate, {
        name: "groq.chat.completions.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => extractGroqCompletionInput(params),
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
  const metrics: Record<string, number> = { ...aggregated.metrics };
  const retainedMetricNames = new Set(["cached"]);
  for (const chunk of chunks) {
    const normalizedMetrics = parseGroqMetrics(chunk);
    for (const name of Object.keys(normalizedMetrics)) {
      retainedMetricNames.add(name);
    }
    Object.assign(metrics, normalizedMetrics);
  }
  for (const name of Object.keys(metrics)) {
    if (!retainedMetricNames.has(name)) {
      delete metrics[name];
    }
  }
  const reasoning = aggregateGroqReasoning(chunks);
  if (reasoning !== undefined) {
    const message = aggregated.output[0]?.message;
    if (message) {
      message.reasoning = reasoning;
    }
  }
  return {
    metrics,
    output: aggregated.output,
  };
}

function aggregateGroqReasoning(
  chunks: GroqChatCompletionChunk[],
): string | undefined {
  let reasoning = "";

  for (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta;
    const deltaReasoning = delta?.reasoning;
    if (typeof deltaReasoning === "string") {
      reasoning += deltaReasoning;
    }
  }

  return reasoning.length > 0 ? reasoning : undefined;
}
