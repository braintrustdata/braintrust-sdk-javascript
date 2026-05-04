import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceSyncStreamChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import { startSpan } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp, isObject } from "../../util";
import { SpanTypeAttribute } from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { genkitChannels } from "./genkit-channels";
import type {
  GenkitAction,
  GenkitActionMetadata,
  GenkitEmbedManyParams,
  GenkitEmbedParams,
  GenkitGenerateInput,
  GenkitGenerateResponse,
  GenkitGenerateResponseChunk,
  GenkitGenerateStreamResponse,
  GenkitUsage,
} from "../../vendor-sdk-types/genkit";

type SpanState = {
  span: Span;
  startTime: number;
};

export class GenkitPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToGenkitChannels();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToGenkitChannels(): void {
    this.unsubscribers.push(
      traceAsyncChannel(genkitChannels.generate, {
        name: "genkit.generate",
        type: SpanTypeAttribute.FUNCTION,
        extractInput: ([input]) => extractGenerateInput(input),
        extractOutput: extractGenerateOutput,
        extractMetadata: (result, event) =>
          extractGenerateResponseMetadata(result, event?.arguments?.[0]),
        extractMetrics: (result) => parseGenkitUsageMetrics(result?.usage),
      }),
    );

    this.unsubscribers.push(
      traceSyncStreamChannel(genkitChannels.generateStream, {
        name: "genkit.generateStream",
        type: SpanTypeAttribute.FUNCTION,
        extractInput: ([input]) => extractGenerateInput(input),
        patchResult: ({ result, span, startTime }) =>
          patchGenerateStreamResult(result, span, startTime),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(genkitChannels.embed, {
        name: "genkit.embed",
        type: SpanTypeAttribute.FUNCTION,
        extractInput: ([params]) => extractEmbedInput(params),
        extractOutput: (result) => summarizeEmbeddingResult(result),
        extractMetadata: (_result, event) =>
          extractEmbedMetadata(event?.arguments?.[0]),
        extractMetrics: () => ({}),
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(genkitChannels.embedMany, {
        name: "genkit.embedMany",
        type: SpanTypeAttribute.FUNCTION,
        extractInput: ([params]) => extractEmbedManyInput(params),
        extractOutput: summarizeEmbeddingResult,
        extractMetadata: (_result, event) =>
          extractEmbedMetadata(event?.arguments?.[0]),
        extractMetrics: () => ({}),
      }),
    );

    this.subscribeToActionRun();
    this.subscribeToActionStream();
  }

  private subscribeToActionRun(): void {
    const tracingChannel =
      genkitChannels.actionRun.tracingChannel() as IsoTracingChannel<
        ChannelMessage<typeof genkitChannels.actionRun>
      >;
    const states = new WeakMap<object, SpanState>();

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof genkitChannels.actionRun>
    > = {
      start: (event) => {
        const metadata = extractActionMetadata(event.self);
        const runStepName =
          !metadata && typeof event.arguments[0] === "string"
            ? event.arguments[0]
            : undefined;
        const span = startSpan({
          name: actionSpanName(metadata, runStepName),
          spanAttributes: {
            type: actionSpanType(metadata),
          },
        });
        const startTime = getCurrentUnixTimestamp();

        span.log({
          input: runStepName ? event.arguments[1] : event.arguments[0],
          metadata: actionMetadataForLog(metadata, runStepName),
        });
        states.set(event, { span, startTime });
      },
      asyncEnd: (event) => {
        const state = states.get(event);
        if (!state) {
          return;
        }

        try {
          state.span.log({
            output: extractActionOutput(event.result),
            metrics: durationMetrics(state.startTime),
          });
        } finally {
          state.span.end();
          states.delete(event);
        }
      },
      error: (event) => {
        const state = states.get(event);
        if (!state || !event.error) {
          return;
        }
        state.span.log({ error: event.error.message });
        state.span.end();
        states.delete(event);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => tracingChannel.unsubscribe(handlers));
  }

  private subscribeToActionStream(): void {
    this.unsubscribers.push(
      traceSyncStreamChannel(genkitChannels.actionStream, {
        name: "genkit.action.stream",
        type: SpanTypeAttribute.TASK,
        extractInput: ([input], event) => ({
          input,
          metadata: actionMetadataForLog(extractActionMetadata(event.self)),
        }),
        patchResult: ({ result, span, startTime }) =>
          patchActionStreamResult(result, span, startTime),
      }),
    );
  }
}

function normalizeInput(input: GenkitGenerateInput): GenkitGenerateInput {
  if (typeof input === "string" || Array.isArray(input)) {
    return { prompt: input };
  }
  return input;
}

function extractGenerateInput(input: GenkitGenerateInput): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const normalized = normalizeInput(input);
  if (!isObject(normalized)) {
    return {
      input: undefined,
      metadata: genkitProviderMetadata(),
    };
  }

  const options = normalized as Record<string, unknown>;
  return {
    input: processInputAttachments(
      options.prompt ?? options.messages ?? options.system,
    ),
    metadata: {
      ...genkitProviderMetadata(),
      ...pickDefined({
        model: modelName(options.model),
        temperature: configValue(options.config, "temperature"),
        maxOutputTokens: configValue(options.config, "maxOutputTokens"),
        max_output_tokens: configValue(options.config, "max_output_tokens"),
      }),
    },
  };
}

function extractGenerateOutput(result: GenkitGenerateResponse | undefined) {
  if (!isObject(result)) {
    return result;
  }

  return pickDefined({
    text: safeGet(result, "text"),
    output: safeGet(result, "output"),
    message: safeGet(result, "message"),
    finishReason: safeGet(result, "finishReason"),
    finishMessage: safeGet(result, "finishMessage"),
  });
}

function extractGenerateResponseMetadata(
  result: GenkitGenerateResponse | undefined,
  input: GenkitGenerateInput | undefined,
): Record<string, unknown> {
  const normalized = input ? normalizeInput(input) : undefined;
  const request = isObject(result?.request)
    ? (result?.request as Record<string, unknown>)
    : isObject(normalized)
      ? (normalized as Record<string, unknown>)
      : undefined;

  return {
    ...genkitProviderMetadata(),
    ...pickDefined({
      model: modelName(result?.model ?? request?.model),
      finishReason: result?.finishReason,
      finishMessage: result?.finishMessage,
    }),
  };
}

function extractEmbedInput(params: GenkitEmbedParams | undefined): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  return {
    input: processInputAttachments(params?.content),
    metadata: extractEmbedMetadata(params),
  };
}

function extractEmbedManyInput(params: GenkitEmbedManyParams | undefined): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  return {
    input: processInputAttachments(params?.content),
    metadata: extractEmbedMetadata(params),
  };
}

function extractEmbedMetadata(
  params: GenkitEmbedParams | GenkitEmbedManyParams | undefined,
): Record<string, unknown> {
  return {
    ...genkitProviderMetadata(),
    ...pickDefined({
      model: modelName(params?.embedder),
    }),
  };
}

function summarizeEmbeddingResult(result: unknown): unknown {
  if (Array.isArray(result)) {
    return {
      embedding_count: result.length,
      dimensions:
        Array.isArray(result[0]) || Array.isArray(result[0]?.embedding)
          ? (result[0] as number[]).length || result[0]?.embedding?.length
          : undefined,
    };
  }

  if (isObject(result) && Array.isArray(result.embeddings)) {
    return {
      embedding_count: result.embeddings.length,
      dimensions: Array.isArray(result.embeddings[0])
        ? result.embeddings[0].length
        : undefined,
    };
  }

  return result;
}

function patchGenerateStreamResult(
  result: GenkitGenerateStreamResponse,
  span: Span,
  startTime: number,
): boolean {
  if (!isObject(result) || !isAsyncIterableLike(result.stream)) {
    return false;
  }

  let firstChunkTime: number | undefined;
  const chunks: GenkitGenerateResponseChunk[] = [];

  void (async () => {
    try {
      for await (const chunk of result.stream) {
        if (firstChunkTime === undefined) {
          firstChunkTime = getCurrentUnixTimestamp();
        }
        chunks.push(chunk);
      }

      const response = await result.response;
      const metrics = parseGenkitUsageMetrics(response?.usage);
      if (firstChunkTime !== undefined) {
        metrics.time_to_first_token = firstChunkTime - startTime;
      }

      span.log({
        output: {
          ...extractGenerateOutput(response),
          streamedText: chunks.map((chunk) => safeGet(chunk, "text")).join(""),
        },
        metadata: extractGenerateResponseMetadata(response, undefined),
        metrics,
      });
    } catch (error) {
      span.log({ error: errorMessage(error) });
    } finally {
      span.end();
    }
  })();

  return true;
}

function patchActionStreamResult(
  result: ReturnType<NonNullable<GenkitAction["stream"]>>,
  span: Span,
  startTime: number,
): boolean {
  if (!isObject(result) || !isAsyncIterableLike(result.stream)) {
    return false;
  }

  void (async () => {
    const chunks: unknown[] = [];
    try {
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      span.log({
        output: {
          chunks,
          result: await result.output,
        },
        metrics: durationMetrics(startTime),
      });
    } catch (error) {
      span.log({ error: errorMessage(error) });
    } finally {
      span.end();
    }
  })();

  return true;
}

function parseGenkitUsageMetrics(
  usage: GenkitUsage | undefined,
): Record<string, number> {
  if (!isObject(usage)) {
    return {};
  }

  return pickNumberMetrics({
    tokens: usage.totalTokens,
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    cached_tokens: usage.cachedContentTokens,
    reasoning_tokens: usage.thoughtsTokens,
  });
}

function durationMetrics(startTime: number): Record<string, number> {
  const end = getCurrentUnixTimestamp();
  return {
    start: startTime,
    end,
    duration: end - startTime,
  };
}

function extractActionMetadata(
  self: unknown,
): GenkitActionMetadata | undefined {
  if (!isObject(self) || !isObject(self.__action)) {
    return undefined;
  }
  return self.__action as GenkitActionMetadata;
}

function actionSpanName(
  metadata: GenkitActionMetadata | undefined,
  runStepName?: string,
): string {
  const actionType = metadata?.actionType;
  const name = metadata?.name;
  if (actionType && name) {
    return `genkit.${actionType}: ${name}`;
  }
  if (name) {
    return `genkit.action: ${name}`;
  }
  if (runStepName) {
    return `genkit.run: ${runStepName}`;
  }
  return "genkit.action";
}

function actionSpanType(metadata: GenkitActionMetadata | undefined): string {
  switch (metadata?.actionType) {
    case "tool":
    case "tool.v2":
      return SpanTypeAttribute.TOOL;
    case "model":
    case "embedder":
      return SpanTypeAttribute.LLM;
    default:
      return SpanTypeAttribute.TASK;
  }
}

function actionMetadataForLog(
  metadata: GenkitActionMetadata | undefined,
  runStepName?: string,
): Record<string, unknown> {
  return {
    ...genkitProviderMetadata(),
    ...pickDefined({
      "genkit.action_type": metadata?.actionType,
      "genkit.action_name": metadata?.name,
      "genkit.action_key": metadata?.key,
      "genkit.run_name": runStepName,
    }),
  };
}

function extractActionOutput(result: unknown): unknown {
  if (isObject(result) && "result" in result) {
    return result.result;
  }
  return result;
}

function genkitProviderMetadata(): Record<string, unknown> {
  return { provider: "genkit" };
}

function safeGet(value: unknown, key: string): unknown {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function configValue(config: unknown, key: string): unknown {
  return isObject(config) ? config[key] : undefined;
}

function modelName(model: unknown): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  if (isObject(model)) {
    const name = model.name ?? model.model;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function pickDefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function pickNumberMetrics(
  values: Record<string, unknown>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] => {
      const value = entry[1];
      return typeof value === "number" && Number.isFinite(value);
    }),
  );
}

function isAsyncIterableLike(value: unknown): value is AsyncIterable<unknown> {
  return (
    isObject(value) &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
