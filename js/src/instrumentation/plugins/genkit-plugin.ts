import { withCurrent } from "../../logger";
import { BasePlugin, toLoggedError } from "../core";
import {
  traceAsyncCall,
  traceSyncStreamCall,
  unsubscribeAll,
} from "../core/channel-tracing";
import { observeResult, runInstrumentation } from "../core/observe-result";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";

import { SpanTypeAttribute } from "../../../util/index";
import type { Span } from "../../logger";
import { startSpan as startBaseSpan } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp, isObject } from "../../util";
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
import { processInputAttachments } from "../../wrappers/attachment-utils";
import type { ChannelMessage } from "../core/tracing-types";
import { genkitChannels, genkitCoreChannels } from "./genkit-channels";

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
      genkitChannels.generate.intercept((target, receiver, args, additional) =>
        traceAsyncCall<typeof genkitChannels.generate>(
          () => Reflect.apply(target, receiver, args),
          { ...additional, arguments: args, self: receiver },
          {
            instrumentationName: INSTRUMENTATION_NAMES.GENKIT,
            name: "genkit.generate",
            type: SpanTypeAttribute.LLM,
            extractInput: ([input]) => extractGenerateInput(input),
            extractOutput: extractGenerateOutput,
            extractMetadata: (result, event) =>
              extractGenerateResponseMetadata(result, event?.arguments?.[0]),
            extractMetrics: (result) => parseGenkitUsageMetrics(result?.usage),
          },
        ),
      ),
    );

    this.unsubscribers.push(
      genkitChannels.generateStream.intercept(
        (target, receiver, args, additional) =>
          traceSyncStreamCall<typeof genkitChannels.generateStream>(
            () => Reflect.apply(target, receiver, args),
            { ...additional, arguments: args, self: receiver },
            {
              instrumentationName: INSTRUMENTATION_NAMES.GENKIT,
              name: "genkit.generateStream",
              type: SpanTypeAttribute.LLM,
              extractInput: ([input]) => extractGenerateInput(input),
              patchResult: ({ result, span, startTime }) =>
                patchGenerateStreamResult(result, span, startTime),
            },
          ),
      ),
    );

    this.unsubscribers.push(
      genkitChannels.embed.intercept((target, receiver, args, additional) =>
        traceAsyncCall<typeof genkitChannels.embed>(
          () => Reflect.apply(target, receiver, args),
          { ...additional, arguments: args, self: receiver },
          {
            instrumentationName: INSTRUMENTATION_NAMES.GENKIT,
            name: "genkit.embed",
            type: SpanTypeAttribute.FUNCTION,
            extractInput: ([params]) => extractEmbedInput(params),
            extractOutput: (result) => summarizeEmbeddingResult(result),
            extractMetadata: (_result, event) =>
              extractEmbedMetadata(event?.arguments?.[0]),
            extractMetrics: () => ({}),
          },
        ),
      ),
    );

    this.unsubscribers.push(
      genkitChannels.embedMany.intercept((target, receiver, args, additional) =>
        traceAsyncCall<typeof genkitChannels.embedMany>(
          () => Reflect.apply(target, receiver, args),
          { ...additional, arguments: args, self: receiver },
          {
            instrumentationName: INSTRUMENTATION_NAMES.GENKIT,
            name: "genkit.embedMany",
            type: SpanTypeAttribute.FUNCTION,
            extractInput: ([params]) => extractEmbedManyInput(params),
            extractOutput: summarizeEmbeddingResult,
            extractMetadata: (_result, event) =>
              extractEmbedMetadata(event?.arguments?.[0]),
            extractMetrics: () => ({}),
          },
        ),
      ),
    );

    this.subscribeToActionRun();
    this.subscribeToActionSpan();
    this.subscribeToActionStream();
  }

  private subscribeToActionRun(): void {
    const invocationHook = genkitChannels.actionRun;
    const states = new WeakMap<object, SpanState>();

    const removeHandlers = invocationHook.intercept(
      (target, receiver, args, additional) => {
        const event = {
          ...additional,
          arguments: args,
          self: receiver,
        } as ChannelMessage<typeof genkitChannels.actionRun>;
        const spanState = runInstrumentation(
          () =>
            states.get(event) ?? ((event) => startActionRunSpan(event))(event),
        );
        if (spanState) states.set(event, spanState);
        const prepare = (
          event: ChannelMessage<typeof genkitChannels.actionRun>,
        ) => {
          ensureActionSpanState(states, event as object, () =>
            startActionRunSpan(event),
          );
        };
        const resolved = (
          event: ChannelMessage<typeof genkitChannels.actionRun>,
        ) => {
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
        };
        const failed = (
          event: ChannelMessage<typeof genkitChannels.actionRun>,
        ) => {
          const state = states.get(event);
          if (!state || !event.error) {
            return;
          }
          state.span.log({ error: event.error.message });
          state.span.end();
          states.delete(event);
        };
        const invoke = () => {
          runInstrumentation(() => prepare(event));
          let result;
          try {
            result = Reflect.apply(target, receiver, args);
          } catch (error) {
            Object.assign(event, { error });
            runInstrumentation(() => failed(event));
            throw error;
          }

          return observeResult(
            result,
            (value) => {
              Object.assign(event, { result: value });
              resolved(event);
            },
            (error) => {
              Object.assign(event, { error });
              failed(event);
            },
          );
        };
        return spanState ? withCurrent(spanState.span, invoke) : invoke();
      },
    );
    this.unsubscribers.push(removeHandlers);
  }

  private subscribeToActionSpan(): void {
    const invocationHook = genkitCoreChannels.actionSpan;
    const states = new WeakMap<object, SpanState>();

    const removeHandlers = invocationHook.intercept(
      (target, receiver, args, additional) => {
        const event = {
          ...additional,
          arguments: args,
          self: receiver,
        } as ChannelMessage<typeof genkitCoreChannels.actionSpan>;
        const spanState = runInstrumentation(
          () => states.get(event) ?? ((event) => startActionSpan(event))(event),
        );
        if (spanState) states.set(event, spanState);
        const prepare = (
          event: ChannelMessage<typeof genkitCoreChannels.actionSpan>,
        ) => {
          ensureActionSpanState(states, event as object, () =>
            startActionSpan(event),
          );
        };
        const resolved = (
          event: ChannelMessage<typeof genkitCoreChannels.actionSpan>,
        ) => {
          const state = states.get(event as object);
          if (!state) {
            return;
          }

          try {
            state.span.log({
              input: extractActionSpanInput(event.arguments),
              output: extractActionOutput(event.result),
              metrics: durationMetrics(state.startTime),
            });
          } finally {
            state.span.end();
            states.delete(event as object);
          }
        };
        const failed = (
          event: ChannelMessage<typeof genkitCoreChannels.actionSpan>,
        ) => {
          const state = states.get(event as object);
          if (!state || !event.error) {
            return;
          }
          state.span.log({ error: event.error.message });
          state.span.end();
          states.delete(event as object);
        };
        const invoke = () => {
          runInstrumentation(() => prepare(event));
          let result;
          try {
            result = Reflect.apply(target, receiver, args);
          } catch (error) {
            Object.assign(event, { error });
            runInstrumentation(() => failed(event));
            throw error;
          }

          return observeResult(
            result,
            (value) => {
              Object.assign(event, { result: value });
              resolved(event);
            },
            (error) => {
              Object.assign(event, { error });
              failed(event);
            },
          );
        };
        return spanState ? withCurrent(spanState.span, invoke) : invoke();
      },
    );
    this.unsubscribers.push(removeHandlers);
  }

  private subscribeToActionStream(): void {
    this.unsubscribers.push(
      genkitChannels.actionStream.intercept(
        (target, receiver, args, additional) =>
          traceSyncStreamCall<typeof genkitChannels.actionStream>(
            () => Reflect.apply(target, receiver, args),
            { ...additional, arguments: args, self: receiver },
            {
              instrumentationName: INSTRUMENTATION_NAMES.GENKIT,
              name: "genkit.action.stream",
              type: SpanTypeAttribute.TASK,
              extractInput: ([input], event) => ({
                input,
                metadata: actionMetadataForLog(
                  extractActionMetadata(event.self),
                ),
              }),
              patchResult: ({ result, span, startTime }) =>
                patchActionStreamResult(result, span, startTime),
            },
          ),
      ),
    );
  }
}

function startActionRunSpan(
  event: ChannelMessage<typeof genkitChannels.actionRun>,
): SpanState | undefined {
  const metadata = extractActionMetadata(event.self);
  const runStepName =
    !metadata && typeof event.arguments[0] === "string"
      ? event.arguments[0]
      : undefined;
  return startActionSpanState({
    input: runStepName ? event.arguments[1] : event.arguments[0],
    metadata,
    runStepName,
  });
}

function startActionSpan(
  event: ChannelMessage<typeof genkitCoreChannels.actionSpan>,
): SpanState | undefined {
  const metadata = extractActionSpanMetadata(event.arguments);
  if (!metadata) {
    return undefined;
  }

  return startActionSpanState({
    input: extractActionSpanInput(event.arguments),
    metadata,
  });
}

function startActionSpanState(args: {
  input?: unknown;
  metadata?: GenkitActionMetadata;
  runStepName?: string;
}): SpanState | undefined {
  if (!shouldTraceAction(args.metadata, args.runStepName)) {
    return undefined;
  }

  const span = startBaseSpan(
    withSpanInstrumentationName(
      {
        name: actionSpanName(args.metadata, args.runStepName),
        spanAttributes: {
          type: actionSpanType(args.metadata),
        },
      },
      INSTRUMENTATION_NAMES.GENKIT,
    ),
  );
  const startTime = getCurrentUnixTimestamp();

  span.log({
    input: args.input,
    metadata: actionMetadataForLog(args.metadata, args.runStepName),
  });
  return { span, startTime };
}

function ensureActionSpanState(
  states: WeakMap<object, SpanState>,
  event: object,
  create: () => SpanState | undefined,
): SpanState | undefined {
  const existing = states.get(event);
  if (existing) {
    return existing;
  }

  const created = create();
  if (created) {
    states.set(event, created);
  }
  return created;
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
  if (!isObject(result) || !isAsyncIterable(result.stream)) {
    return false;
  }

  let firstChunkTime: number | undefined;
  const finishSpan = createDeferredSpanFinalizer(span);

  patchStreamIfNeeded<GenkitGenerateResponseChunk>(result.stream, {
    onChunk: () => {
      if (firstChunkTime === undefined) {
        firstChunkTime = getCurrentUnixTimestamp();
      }
    },
    onComplete: (chunks) => {
      // Do not await response processing from iterator.next(); Genkit streams
      // are single-queue async iterables and user consumption should stay in control.
      finishSpan(async () => {
        const streamedText = chunks
          .map((chunk) => safeGet(chunk, "text"))
          .join("");
        const response = await result.response;
        const metrics = parseGenkitUsageMetrics(response?.usage);
        if (firstChunkTime !== undefined) {
          metrics.time_to_first_token = firstChunkTime - startTime;
        }

        span.log({
          output: {
            ...extractGenerateOutput(response),
            streamedText,
          },
          metadata: extractGenerateResponseMetadata(response, undefined),
          metrics,
        });
      });
    },
    onError: (error) => {
      finishSpan(() => {
        span.log({ error: error.message });
      });
    },
  });

  return true;
}

function patchActionStreamResult(
  result: ReturnType<NonNullable<GenkitAction["stream"]>>,
  span: Span,
  startTime: number,
): boolean {
  if (!isObject(result) || !isAsyncIterable(result.stream)) {
    return false;
  }

  const finishSpan = createDeferredSpanFinalizer(span);

  patchStreamIfNeeded(result.stream, {
    onComplete: (chunks) => {
      // Do not await output processing from iterator.next(); Genkit streams
      // are single-queue async iterables and user consumption should stay in control.
      finishSpan(async () => {
        span.log({
          output: {
            chunks,
            result: await result.output,
          },
          metrics: durationMetrics(startTime),
        });
      });
    },
    onError: (error) => {
      finishSpan(() => {
        span.log({ error: error.message });
      });
    },
  });

  return true;
}

function createDeferredSpanFinalizer(
  span: Span,
): (callback: () => void | Promise<void>) => void {
  let finished = false;
  return (callback) => {
    if (finished) {
      return;
    }
    finished = true;
    void (async () => {
      try {
        await callback();
      } catch (error) {
        span.log({ error: toLoggedError(error) });
      } finally {
        span.end();
      }
    })();
  };
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

function extractActionSpanMetadata(
  args: unknown[],
): GenkitActionMetadata | undefined {
  const options = extractRunInNewSpanOptions(args);
  const labels = isObject(options?.labels)
    ? (options.labels as Record<string, unknown>)
    : undefined;
  const metadata = isObject(options?.metadata)
    ? (options.metadata as Record<string, unknown>)
    : undefined;
  const actionType = stringValue(labels?.["genkit:metadata:subtype"]);
  const name = stringValue(metadata?.name);

  if (!actionType || !name) {
    return undefined;
  }

  return {
    actionType,
    key: stringValue(labels?.["genkit:key"]),
    name,
  };
}

function extractActionSpanInput(args: unknown[]): unknown {
  const options = extractRunInNewSpanOptions(args);
  if (!isObject(options?.metadata)) {
    return undefined;
  }
  return options.metadata.input;
}

function extractRunInNewSpanOptions(
  args: unknown[],
): Record<string, unknown> | undefined {
  const options = args.length === 3 ? args[1] : args[0];
  return isObject(options) ? (options as Record<string, unknown>) : undefined;
}

function shouldTraceAction(
  metadata: GenkitActionMetadata | undefined,
  runStepName?: string,
): boolean {
  if (runStepName) {
    return true;
  }

  switch (metadata?.actionType) {
    case "model":
    case "background-model":
    case "embedder":
      return false;
    default:
      return Boolean(metadata);
  }
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
