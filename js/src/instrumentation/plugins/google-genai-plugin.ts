import { uint8ArrayToBase64 } from "../../../util/bytes";
import {
  getExtensionFromMediaType,
  isAutoCaptureAttachmentsEnabled,
  omitMediaData,
  processInputAttachments,
} from "../../wrappers/attachment-utils";
import { debugLogger } from "../../debug-logger";
import { BasePlugin } from "../core";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import type {
  ChannelMessage,
  ErrorOf,
  StartOf,
} from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import {
  _internalGetGlobalState,
  Attachment,
  CAPTURE_ATTACHMENTS,
  currentSpan,
  BRAINTRUST_CURRENT_SPAN_STORE,
  startSpan as startBaseSpan,
  withCurrent,
  type CurrentSpanStore,
  type Span,
  type StartSpanArgs,
} from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { googleGenAIChannels } from "./google-genai-channels";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import type {
  GoogleGenAIEmbedContentParams,
  GoogleGenAIEmbedContentResponse,
  GoogleGenAIEditImageParams,
  GoogleGenAIGenerateContentParams,
  GoogleGenAIGenerateContentResponse,
  GoogleGenAIGenerateImagesParams,
  GoogleGenAIGenerateImagesResponse,
  GoogleGenAIGenerateVideosOperation,
  GoogleGenAIGenerateVideosParams,
  GoogleGenAIImage,
  GoogleGenAIVideo,
  GoogleGenAIContent,
  GoogleGenAIInteraction,
  GoogleGenAIInteractionContent,
  GoogleGenAIInteractionCreateParams,
  GoogleGenAIInteractionSSEEvent,
  GoogleGenAIInteractionUsage,
  GoogleGenAIPart,
  GoogleGenAIUsageMetadata,
} from "../../vendor-sdk-types/google-genai";

type GenerateContentChannel = typeof googleGenAIChannels.generateContent;
type GenerateContentStreamChannel =
  typeof googleGenAIChannels.generateContentStream;
type EmbedContentChannel = typeof googleGenAIChannels.embedContent;
type InteractionsCreateChannel = typeof googleGenAIChannels.interactionsCreate;
type GoogleGenAINonStreamingChannel =
  | GenerateContentChannel
  | EmbedContentChannel;
type GenerateContentStreamEvent =
  ChannelMessage<GenerateContentStreamChannel> & {
    googleGenAIInput?: Record<string, unknown>;
    googleGenAIMetadata?: Record<string, unknown>;
    googleGenAIStartTime?: number;
    captureAttachments?: boolean;
  };

type SpanState = {
  span: Span;
  startTime: number;
};

const GOOGLE_GENAI_INTERNAL_CONTEXT = {
  caller_filename: "<node-internal>",
  caller_functionname: "<node-internal>",
  caller_lineno: 0,
};

function createWrapperParityEvent(args: {
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): StartSpanArgs["event"] {
  return {
    context: GOOGLE_GENAI_INTERNAL_CONTEXT,
    input: args.input,
    metadata: args.metadata,
  } as StartSpanArgs["event"];
}

/**
 * Auto-instrumentation plugin for the Google GenAI SDK.
 *
 * This plugin subscribes to orchestrion channels for Google GenAI SDK methods
 * and creates Braintrust spans to track:
 * - models.generateContent (non-streaming)
 * - models.generateContentStream (streaming)
 * - models.embedContent (embeddings)
 * - models.generateImages (image generation)
 * - models.editImage (image editing)
 * - models.generateVideos (video job submission)
 *
 * The plugin handles:
 * - Google-specific token metrics (promptTokenCount, candidatesTokenCount, cachedContentTokenCount)
 * - Processing streaming responses
 * - Converting inline data (images) to Attachment objects
 * - Tool calls (functionCall, functionResponse) and executable code results
 */
export class GoogleGenAIPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToGoogleGenAIChannels();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToGoogleGenAIChannels(): void {
    this.subscribeToGenerateContentChannel();
    this.subscribeToGenerateContentStreamChannel();
    this.subscribeToEmbedContentChannel();
    this.subscribeToInteractionsCreateChannel();
    this.subscribeToGenerateImagesChannel();
    this.subscribeToEditImageChannel();
    this.subscribeToGenerateVideosChannel();
  }

  private subscribeToGenerateContentChannel(): void {
    const tracingChannel =
      googleGenAIChannels.generateContent.tracingChannel() as IsoTracingChannel<
        ChannelMessage<GenerateContentChannel>
      >;
    const states = new WeakMap<object, SpanState>();
    const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
      tracingChannel,
      states,
      (event) => {
        const params = event.arguments[0];
        const input = serializeGenerateContentInput(params);
        const metadata = extractGenerateContentMetadata(params);
        const span = startBaseSpan(
          withSpanInstrumentationName(
            {
              name: "generate_content",
              spanAttributes: {
                type: SpanTypeAttribute.LLM,
              },
              event: createWrapperParityEvent({ input, metadata }),
            },
            INSTRUMENTATION_NAMES.GOOGLE_GENAI,
          ),
        );

        return {
          span,
          startTime: getCurrentUnixTimestamp(),
        };
      },
    );

    const handlers: IsoChannelHandlers<ChannelMessage<GenerateContentChannel>> =
      {
        start: (event) => {
          ensureSpanState(states, event, () => {
            const params = event.arguments[0];
            const input = serializeGenerateContentInput(params);
            const metadata = extractGenerateContentMetadata(params);
            const span = startBaseSpan(
              withSpanInstrumentationName(
                {
                  name: "generate_content",
                  spanAttributes: {
                    type: SpanTypeAttribute.LLM,
                  },
                  event: createWrapperParityEvent({ input, metadata }),
                },
                INSTRUMENTATION_NAMES.GOOGLE_GENAI,
              ),
            );

            return {
              span,
              startTime: getCurrentUnixTimestamp(),
            };
          });
        },
        asyncEnd: (event) => {
          const spanState = states.get(event as object);
          if (!spanState) {
            return;
          }

          try {
            const responseMetadata = extractResponseMetadata(event.result);
            spanState.span.log({
              ...(responseMetadata ? { metadata: responseMetadata } : {}),
              metrics: cleanMetrics(
                extractGenerateContentMetrics(
                  event.result,
                  spanState.startTime,
                ),
              ),
              output: withCurrent(spanState.span, () =>
                serializeGenerateContentOutput(event.result),
              ),
            });
          } finally {
            spanState.span.end();
            states.delete(event as object);
          }
        },
        error: (event) => {
          logErrorAndEndSpan(states, event as ErrorOf<GenerateContentChannel>);
        },
      };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToGenerateContentStreamChannel(): void {
    const tracingChannel =
      googleGenAIChannels.generateContentStream.tracingChannel() as IsoTracingChannel<
        ChannelMessage<GenerateContentStreamChannel>
      >;

    const handlers: IsoChannelHandlers<
      ChannelMessage<GenerateContentStreamChannel>
    > = {
      start: (event) => {
        const streamEvent = event as GenerateContentStreamEvent;
        const params = event.arguments[0];
        streamEvent.googleGenAIInput = serializeGenerateContentInput(params);
        streamEvent.googleGenAIMetadata =
          extractGenerateContentMetadata(params);
        streamEvent.googleGenAIStartTime = getCurrentUnixTimestamp();
        streamEvent.captureAttachments = isAutoCaptureAttachmentsEnabled();
      },
      asyncEnd: (event) => {
        const streamEvent = event as GenerateContentStreamEvent;
        patchGoogleGenAIStreamingResult({
          captureAttachments: streamEvent.captureAttachments,
          input: streamEvent.googleGenAIInput,
          metadata: streamEvent.googleGenAIMetadata,
          startTime: streamEvent.googleGenAIStartTime,
          result: streamEvent.result,
        });
      },
      error: () => {},
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToEmbedContentChannel(): void {
    const tracingChannel =
      googleGenAIChannels.embedContent.tracingChannel() as IsoTracingChannel<
        ChannelMessage<EmbedContentChannel>
      >;
    const states = new WeakMap<object, SpanState>();
    const embeddingSpans = new WeakSet<Span>();
    this.unsubscribers.push(
      googleGenAIChannels.httpResponseJson.intercept(
        (target, thisArg, args) => {
          const span = currentSpan();
          const result = Reflect.apply(target, thisArg, args);
          if (embeddingSpans.has(span)) {
            // Observe the SDK's own JSON parsing, without cloning/consuming the
            // response again or retaining the embedding vectors.
            void Promise.resolve(result).then(
              (response) => {
                try {
                  const metrics = cleanMetrics(
                    extractEmbedContentMetrics(response),
                  );
                  if (
                    embeddingSpans.has(span) &&
                    Object.keys(metrics).length > 0
                  ) {
                    span.log({ metrics });
                  }
                } catch (error) {
                  debugLogger.error(
                    "Error reading Google GenAI embedding usage:",
                    error,
                  );
                }
              },
              () => {}, // The embedding channel handles the original rejection.
            );
          }
          return result;
        },
      ),
    );
    const unbindCurrentSpanStore = bindCurrentSpanStoreToStart(
      tracingChannel,
      states,
      (event) => {
        const params = event.arguments[0];
        const input = serializeEmbedContentInput(params);
        const metadata = { provider: "google", model: params.model };
        const span = startBaseSpan(
          withSpanInstrumentationName(
            {
              name: "embed_content",
              spanAttributes: {
                type: SpanTypeAttribute.LLM,
              },
              event: createWrapperParityEvent({ input, metadata }),
            },
            INSTRUMENTATION_NAMES.GOOGLE_GENAI,
          ),
        );

        embeddingSpans.add(span);
        return {
          span,
          startTime: getCurrentUnixTimestamp(),
        };
      },
    );

    const handlers: IsoChannelHandlers<ChannelMessage<EmbedContentChannel>> = {
      start: (event) => {
        ensureSpanState(states, event, () => {
          const params = event.arguments[0];
          const input = serializeEmbedContentInput(params);
          const metadata = { provider: "google", model: params.model };
          const span = startBaseSpan(
            withSpanInstrumentationName(
              {
                name: "embed_content",
                spanAttributes: {
                  type: SpanTypeAttribute.LLM,
                },
                event: createWrapperParityEvent({ input, metadata }),
              },
              INSTRUMENTATION_NAMES.GOOGLE_GENAI,
            ),
          );

          embeddingSpans.add(span);
          return {
            span,
            startTime: getCurrentUnixTimestamp(),
          };
        });
      },
      asyncEnd: (event) => {
        const spanState = states.get(event as object);
        if (!spanState) {
          return;
        }

        try {
          spanState.span.log({
            output: summarizeEmbedContentOutput(event.result),
            metrics: cleanMetrics(
              extractEmbedContentMetrics(event.result, spanState.startTime),
            ),
          });
        } finally {
          embeddingSpans.delete(spanState.span);
          spanState.span.end();
          states.delete(event as object);
        }
      },
      error: (event) => {
        const spanState = states.get(event as object);
        if (!spanState) return;
        try {
          spanState.span.log({ error: event.error, output: { count: 0 } });
        } finally {
          embeddingSpans.delete(spanState.span);
          spanState.span.end();
          states.delete(event as object);
        }
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      unbindCurrentSpanStore?.();
      tracingChannel.unsubscribe(handlers);
    });
  }

  private subscribeToInteractionsCreateChannel(): void {
    this.unsubscribers.push(
      traceStreamingChannel(
        googleGenAIChannels.interactionsCreate as InteractionsCreateChannel,
        {
          name: ([params]) =>
            isVideoInteractionCreate(params)
              ? "generate_video"
              : "create_interaction",
          shouldTrace: ([params]) => !isBackgroundInteractionCreate(params),
          type: SpanTypeAttribute.LLM,
          extractInput: ([params]) => ({
            input: isVideoInteractionCreate(params)
              ? serializeVideoInteractionInput(params)
              : serializeInteractionInput(params),
            metadata: isVideoInteractionCreate(params)
              ? { model: params.model, provider: "google" }
              : extractInteractionMetadata(params),
          }),
          extractOutput: (result, event) =>
            isVideoInteractionCreate(event?.arguments?.[0]) ||
            getInteractionVideoOutput(result).length > 0
              ? serializeVideoInteractionOutput(result)
              : serializeInteractionValue(result),
          extractMetadata: (result) =>
            extractInteractionResponseMetadata(result),
          extractMetrics: (result, startTime) =>
            cleanMetrics(extractInteractionMetrics(result, startTime)),
          aggregateChunks: (chunks, _result, _event, startTime) =>
            aggregateInteractionEvents(chunks, startTime),
        },
      ),
    );
  }

  private subscribeToGenerateImagesChannel(): void {
    this.unsubscribers.push(
      interceptGoogleGenAIMediaCall(
        googleGenAIChannels.generateImages,
        "generate_images",
        serializeGenerateImagesInput,
        serializeGenerateImagesOutput,
      ),
    );
  }

  private subscribeToEditImageChannel(): void {
    this.unsubscribers.push(
      interceptGoogleGenAIMediaCall(
        googleGenAIChannels.editImage,
        "edit_image",
        serializeEditImageInput,
        serializeGenerateImagesOutput,
      ),
    );
  }

  private subscribeToGenerateVideosChannel(): void {
    this.unsubscribers.push(
      interceptGoogleGenAIMediaCall(
        googleGenAIChannels.generateVideos,
        "generate_videos",
        serializeGenerateVideosInput,
        serializeGenerateVideosOutput,
      ),
    );
  }
}

type GoogleGenAIMediaChannel<TParams extends { model: string }, TResult> = {
  intercept(
    interceptor: (
      target: (this: unknown, params: TParams) => PromiseLike<TResult>,
      thisArg: unknown,
      args: [TParams],
    ) => PromiseLike<TResult>,
  ): () => void;
};

function interceptGoogleGenAIMediaCall<
  TParams extends { model: string },
  TResult,
>(
  channel: GoogleGenAIMediaChannel<TParams, TResult>,
  name: string,
  serializeInput: (params: TParams) => Record<string, unknown>,
  serializeOutput: (
    response: TResult,
    params: TParams,
  ) => Record<string, unknown>,
): () => void {
  return channel.intercept((target, thisArg, args) => {
    const invoke = () => Reflect.apply(target, thisArg, args);
    if (isAutoInstrumentationSuppressed()) {
      return invoke();
    }

    const [params] = args;
    let span: Span;
    try {
      span = startBaseSpan(
        withSpanInstrumentationName(
          {
            name,
            spanAttributes: { type: SpanTypeAttribute.LLM },
            event: createWrapperParityEvent({
              input: serializeInput(params),
              metadata: { model: params.model, provider: "google" },
            }),
          },
          INSTRUMENTATION_NAMES.GOOGLE_GENAI,
        ),
      );
    } catch (error) {
      debugLogger.error(`Error starting Google GenAI ${name} span:`, error);
      return invoke();
    }

    let ended = false;
    const finish = (error?: unknown) => {
      if (ended) {
        return;
      }
      ended = true;
      try {
        if (error !== undefined) {
          span.log({ error });
        }
        span.end();
      } catch (loggingError) {
        debugLogger.error(
          `Error ending Google GenAI ${name} span:`,
          loggingError,
        );
      }
    };

    let result: PromiseLike<TResult>;
    try {
      result = withCurrent(span, () =>
        runWithAutoInstrumentationSuppressed(invoke),
      );
    } catch (error) {
      finish(error);
      throw error;
    }

    try {
      void Promise.resolve(result).then((response) => {
        try {
          span.log({
            output: withCurrent(span, () => serializeOutput(response, params)),
          });
        } catch (error) {
          debugLogger.error(
            `Error capturing Google GenAI ${name} output:`,
            error,
          );
        } finally {
          finish();
        }
      }, finish);
    } catch (error) {
      debugLogger.error(`Error observing Google GenAI ${name} result:`, error);
      finish();
    }

    return result;
  });
}

function isBackgroundInteractionCreate(params: unknown): boolean {
  return tryToDict(params)?.background === true;
}

function ensureSpanState<TEvent extends object>(
  states: WeakMap<object, SpanState>,
  event: TEvent,
  create: () => SpanState,
): SpanState {
  const existing = states.get(event);
  if (existing) {
    return existing;
  }

  const created = create();
  states.set(event, created);
  return created;
}

function bindCurrentSpanStoreToStart<
  TChannel extends GoogleGenAINonStreamingChannel,
>(
  tracingChannel: IsoTracingChannel<ChannelMessage<TChannel>>,
  states: WeakMap<object, SpanState>,
  create: (event: StartOf<TChannel>) => SpanState,
): (() => void) | undefined {
  const state = _internalGetGlobalState();
  const contextManager = state?.contextManager;
  const startChannel = tracingChannel.start as
    | ({
        bindStore?: (
          store: CurrentSpanStore,
          callback: (event: ChannelMessage<TChannel>) => unknown,
        ) => void;
        unbindStore?: (store: CurrentSpanStore) => void;
      } & object)
    | undefined;
  const currentSpanStore = contextManager
    ? (
        contextManager as {
          [BRAINTRUST_CURRENT_SPAN_STORE]?: CurrentSpanStore;
        }
      )[BRAINTRUST_CURRENT_SPAN_STORE]
    : undefined;

  if (!startChannel?.bindStore || !currentSpanStore) {
    return undefined;
  }

  startChannel.bindStore(currentSpanStore, (event) => {
    const span = ensureSpanState(states, event as object, () =>
      create(event as StartOf<TChannel>),
    ).span;
    return contextManager!.wrapSpanForStore(span);
  });

  return () => {
    startChannel.unbindStore?.(currentSpanStore);
  };
}

function logErrorAndEndSpan<TChannel extends GoogleGenAINonStreamingChannel>(
  states: WeakMap<object, SpanState>,
  event: ErrorOf<TChannel>,
): void {
  const spanState = states.get(event as object);
  if (!spanState) {
    return;
  }

  spanState.span.log({
    error: event.error.message,
  });
  spanState.span.end();
  states.delete(event as object);
}

function patchGoogleGenAIStreamingResult(args: {
  captureAttachments?: boolean;
  input: Record<string, unknown> | undefined;
  metadata: Record<string, unknown> | undefined;
  startTime: number | undefined;
  result: unknown;
}): boolean {
  const {
    input,
    metadata,
    result,
    startTime,
    captureAttachments = isAutoCaptureAttachmentsEnabled(),
  } = args;

  if (
    !input ||
    !metadata ||
    !result ||
    typeof result !== "object" ||
    typeof (result as AsyncIterator<GoogleGenAIGenerateContentResponse>)
      .next !== "function"
  ) {
    return false;
  }

  const chunks: GoogleGenAIGenerateContentResponse[] = [];
  let firstTokenTime: number | null = null;
  let finalized = false;
  let span: Span | null = null;
  const requestStartTime = startTime ?? getCurrentUnixTimestamp();

  const ensureSpan = () => {
    if (!span) {
      span = startBaseSpan(
        withSpanInstrumentationName(
          {
            name: "generate_content_stream",
            [CAPTURE_ATTACHMENTS]: captureAttachments,
            spanAttributes: {
              type: SpanTypeAttribute.LLM,
            },
            event: {
              input,
              metadata,
            },
          },
          INSTRUMENTATION_NAMES.GOOGLE_GENAI,
        ),
      );
    }

    return span;
  };

  const finalize = (options: {
    error?: unknown;
    result?: {
      aggregated: Record<string, unknown>;
      metrics: Record<string, number>;
    };
  }) => {
    if (finalized || !span) {
      return;
    }

    finalized = true;

    if (options.result) {
      const { end, ...metricsWithoutEnd } = options.result.metrics;
      const responseMetadata = extractResponseMetadata(
        options.result.aggregated,
      );
      span.log({
        ...(responseMetadata ? { metadata: responseMetadata } : {}),
        metrics: cleanMetrics(metricsWithoutEnd),
        output: options.result.aggregated,
      });
      span.end(typeof end === "number" ? { endTime: end } : undefined);
      return;
    }

    if (options.error !== undefined) {
      span.log({
        error:
          options.error instanceof Error
            ? options.error.message
            : String(options.error),
      });
    }

    span.end();
  };

  const patchIterator = (
    iterator: AsyncIterator<GoogleGenAIGenerateContentResponse>,
  ): AsyncIterator<GoogleGenAIGenerateContentResponse> => {
    if (
      typeof iterator !== "object" ||
      iterator === null ||
      "__braintrustGoogleGenAIPatched" in (iterator as object)
    ) {
      return iterator;
    }

    const iteratorRecord =
      iterator as AsyncIterator<GoogleGenAIGenerateContentResponse> &
        Record<string | symbol, unknown>;
    const originalNext =
      typeof iteratorRecord.next === "function"
        ? (
            iteratorRecord.next as (
              ...args: [] | [undefined]
            ) => Promise<IteratorResult<GoogleGenAIGenerateContentResponse>>
          ).bind(iterator)
        : undefined;
    const originalReturn =
      typeof iteratorRecord.return === "function"
        ? (
            iteratorRecord.return as (
              ...args: [] | [unknown]
            ) => Promise<IteratorResult<GoogleGenAIGenerateContentResponse>>
          ).bind(iterator)
        : undefined;
    const originalThrow =
      typeof iteratorRecord.throw === "function"
        ? (
            iteratorRecord.throw as (
              ...args: [] | [unknown]
            ) => Promise<IteratorResult<GoogleGenAIGenerateContentResponse>>
          ).bind(iterator)
        : undefined;
    const asyncIteratorMethod = iteratorRecord[Symbol.asyncIterator];
    const originalAsyncIterator =
      typeof asyncIteratorMethod === "function"
        ? (
            asyncIteratorMethod as () => AsyncIterator<GoogleGenAIGenerateContentResponse>
          ).bind(iterator)
        : undefined;

    Object.defineProperty(iteratorRecord, "__braintrustGoogleGenAIPatched", {
      configurable: true,
      enumerable: false,
      value: true,
      writable: false,
    });

    if (originalNext) {
      iteratorRecord.next = async (...nextArgs: [] | [undefined]) => {
        ensureSpan();

        try {
          const nextResult = (await originalNext(
            ...nextArgs,
          )) as IteratorResult<GoogleGenAIGenerateContentResponse>;

          if (!nextResult.done && nextResult.value) {
            if (firstTokenTime === null) {
              firstTokenTime = getCurrentUnixTimestamp();
            }
            chunks.push(
              captureAttachments
                ? nextResult.value
                : {
                    ...nextResult.value,
                    candidates: nextResult.value.candidates?.map(
                      (candidate) => ({
                        ...candidate,
                        content: candidate.content
                          ? {
                              ...candidate.content,
                              parts: candidate.content.parts?.map((part) =>
                                part.inlineData
                                  ? {
                                      ...part,
                                      // This copy is only retained for trace aggregation.
                                      inlineData: omitMediaData(
                                        part.inlineData,
                                        "data",
                                      ) as GoogleGenAIPart["inlineData"],
                                    }
                                  : part,
                              ),
                            }
                          : candidate.content,
                      }),
                    ),
                  },
            );
          }

          if (nextResult.done) {
            finalize({
              result: aggregateGenerateContentChunks(
                chunks,
                requestStartTime,
                firstTokenTime,
                captureAttachments,
              ),
            });
          }

          return nextResult;
        } catch (error) {
          finalize({ error });
          throw error;
        }
      };
    }

    if (originalReturn) {
      iteratorRecord.return = async (...returnArgs: [] | [unknown]) => {
        ensureSpan();

        try {
          return (await originalReturn(
            ...returnArgs,
          )) as IteratorResult<GoogleGenAIGenerateContentResponse>;
        } finally {
          if (chunks.length > 0) {
            finalize({
              result: aggregateGenerateContentChunks(
                chunks,
                requestStartTime,
                firstTokenTime,
                captureAttachments,
              ),
            });
          } else {
            finalize({});
          }
        }
      };
    }

    if (originalThrow) {
      iteratorRecord.throw = async (...throwArgs: [] | [unknown]) => {
        ensureSpan();

        try {
          return (await originalThrow(
            ...throwArgs,
          )) as IteratorResult<GoogleGenAIGenerateContentResponse>;
        } catch (error) {
          finalize({ error });
          throw error;
        }
      };
    }

    iteratorRecord[Symbol.asyncIterator] = () => {
      const asyncIterator = originalAsyncIterator
        ? (originalAsyncIterator() as AsyncIterator<GoogleGenAIGenerateContentResponse>)
        : iterator;
      return patchIterator(asyncIterator);
    };

    return iterator;
  };

  patchIterator(result as AsyncIterator<GoogleGenAIGenerateContentResponse>);
  return true;
}

function serializeGenerateContentInput(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    model: params.model,
    contents: serializeContentCollection(params.contents),
  };

  const config = params.config ? tryToDict(params.config) : null;
  if (config) {
    const filteredConfig: Record<string, unknown> = {};
    Object.keys(config).forEach((key) => {
      if (key !== "tools") {
        filteredConfig[key] = config[key];
      }
    });
    input.config = filteredConfig;
  }

  return input;
}

function serializeGenerateContentOutput(
  response: GoogleGenAIGenerateContentResponse | undefined,
): GoogleGenAIGenerateContentResponse | undefined {
  if (!response?.candidates) {
    return response;
  }

  return {
    ...response,
    candidates: response.candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.content?.parts
        ? {
            content: {
              ...candidate.content,
              parts: candidate.content.parts
                .map((part) => serializePart(part))
                .filter((part) => part !== undefined),
            },
          }
        : {}),
    })),
  } as GoogleGenAIGenerateContentResponse;
}

function serializeGenerateImagesInput(
  params: GoogleGenAIGenerateImagesParams,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const config = params.config;
  if (config?.numberOfImages !== undefined) {
    parameters.n = config.numberOfImages;
  }
  if (config?.imageSize !== undefined) {
    parameters.size = config.imageSize;
  }
  if (config?.aspectRatio !== undefined) {
    parameters.aspect_ratio = config.aspectRatio;
  }
  if (config?.seed !== undefined) {
    parameters.seed = config.seed;
  }
  if (config?.outputMimeType !== undefined) {
    parameters.output_format = config.outputMimeType;
  }

  return {
    operation: "generate",
    prompt: params.prompt,
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  };
}

function serializeGenerateImagesOutput(
  response: GoogleGenAIGenerateImagesResponse,
  params: GoogleGenAIGenerateImagesParams | GoogleGenAIEditImageParams,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  for (const [index, generatedImage] of (
    response.generatedImages ?? []
  ).entries()) {
    const image = generatedImage?.image;
    if (!image) {
      continue;
    }

    const imagePart = serializeGoogleGenAIImage(
      image,
      `generated-image-${index + 1}`,
      params.config?.outputMimeType,
    );
    if (!imagePart) {
      continue;
    }

    content.push({
      ...imagePart,
      ...(generatedImage.enhancedPrompt
        ? { revised_prompt: generatedImage.enhancedPrompt }
        : {}),
    });
  }

  return { content };
}

function serializeEditImageInput(
  params: GoogleGenAIEditImageParams,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const config = params.config;
  if (config?.numberOfImages !== undefined) {
    parameters.n = config.numberOfImages;
  }
  if (config?.aspectRatio !== undefined) {
    parameters.aspect_ratio = config.aspectRatio;
  }
  if (config?.outputCompressionQuality !== undefined) {
    parameters.quality = config.outputCompressionQuality;
  }
  if (config?.seed !== undefined) {
    parameters.seed = config.seed;
  }
  if (config?.outputMimeType !== undefined) {
    parameters.output_format = config.outputMimeType;
  }

  const content = params.referenceImages.flatMap((reference, index) => {
    if (!reference.referenceImage) {
      return [];
    }
    const purpose = reference.referenceType?.toUpperCase().includes("MASK")
      ? "mask"
      : "reference";
    const image = serializeGoogleGenAIImage(
      reference.referenceImage,
      `${purpose}-image-${index + 1}`,
      undefined,
      purpose,
    );
    return image ? [image] : [];
  });

  return {
    operation: "edit",
    prompt: params.prompt,
    ...(content.length > 0 ? { content } : {}),
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  };
}

function serializeGenerateVideosInput(
  params: GoogleGenAIGenerateVideosParams,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const config = params.config;
  if (config?.durationSeconds !== undefined) {
    parameters.duration = config.durationSeconds;
  }
  if (config?.resolution !== undefined) {
    parameters.size = config.resolution;
  }
  if (config?.aspectRatio !== undefined) {
    parameters.aspect_ratio = config.aspectRatio;
  }
  if (config?.seed !== undefined) {
    parameters.seed = config.seed;
  }

  const content: Record<string, unknown>[] = [];
  const sourceImage = params.image ?? params.source?.image;
  if (sourceImage) {
    const image = serializeGoogleGenAIImage(
      sourceImage,
      "input-image",
      undefined,
      "input",
    );
    if (image) {
      content.push(image);
    }
  }
  const sourceVideo = params.video ?? params.source?.video;
  if (sourceVideo) {
    const video = serializeGoogleGenAIVideo(sourceVideo, "input-video");
    if (video) {
      content.push(video);
    }
  }
  if (config?.lastFrame) {
    const image = serializeGoogleGenAIImage(
      config.lastFrame,
      "last-frame",
      undefined,
      "reference",
    );
    if (image) {
      content.push(image);
    }
  }
  for (const [index, reference] of (config?.referenceImages ?? []).entries()) {
    if (!reference.image) {
      continue;
    }
    const image = serializeGoogleGenAIImage(
      reference.image,
      `reference-image-${index + 1}`,
      undefined,
      "reference",
    );
    if (image) {
      content.push(image);
    }
  }
  if (config?.mask?.image) {
    const image = serializeGoogleGenAIImage(
      config.mask.image,
      "mask-image",
      undefined,
      "mask",
    );
    if (image) {
      content.push(image);
    }
  }

  return {
    operation: "generate",
    ...((params.prompt ?? params.source?.prompt)
      ? { prompt: params.prompt ?? params.source?.prompt }
      : {}),
    ...(content.length > 0 ? { content } : {}),
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  };
}

function serializeGenerateVideosOutput(
  operation: GoogleGenAIGenerateVideosOperation,
): Record<string, unknown> {
  return {
    content: (operation.response?.generatedVideos ?? []).flatMap(
      (generatedVideo, index) => {
        const video = generatedVideo.video
          ? serializeGoogleGenAIVideo(
              generatedVideo.video,
              `generated-video-${index + 1}`,
            )
          : undefined;
        return video ? [video] : [];
      },
    ),
  };
}

function serializeGoogleGenAIImage(
  image: GoogleGenAIImage,
  filenameStem: string,
  fallbackMimeType?: string,
  purpose?: "input" | "reference" | "mask",
): Record<string, unknown> | undefined {
  const captureAttachments = isAutoCaptureAttachmentsEnabled();
  if (!captureAttachments && !image.gcsUri) return undefined;
  const mimeType = image.mimeType ?? fallbackMimeType ?? "image/png";
  const filename = `${filenameStem}.${getExtensionFromMediaType(mimeType)}`;
  const media =
    image.gcsUri ??
    (image.imageBytes
      ? createAttachmentFromInlineData(
          image.imageBytes,
          mimeType,
          filename,
          captureAttachments,
        )
      : undefined);
  if (!media) {
    return undefined;
  }
  return {
    type: "image_url",
    image_url: { url: media },
    ...(purpose ? { purpose } : {}),
  };
}

function serializeGoogleGenAIVideo(
  video: GoogleGenAIVideo,
  filenameStem: string,
): Record<string, unknown> | undefined {
  const captureAttachments = isAutoCaptureAttachmentsEnabled();
  if (!captureAttachments && !video.uri) return undefined;
  const mimeType = video.mimeType ?? "video/mp4";
  const filename = `${filenameStem}.${getExtensionFromMediaType(mimeType)}`;
  const media =
    video.uri ??
    (video.videoBytes
      ? createAttachmentFromInlineData(
          video.videoBytes,
          mimeType,
          filename,
          captureAttachments,
        )
      : undefined);
  return media
    ? { type: "file", file: { filename, file_data: media } }
    : undefined;
}

type EmbeddingContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string | Attachment } }
  | {
      type: "file";
      file: { file_data: string | Attachment; filename?: string };
    };

function serializeEmbedContentInput(
  params: GoogleGenAIEmbedContentParams,
): Record<string, unknown> {
  let contents = Array.isArray(params.contents)
    ? params.contents
    : [params.contents];
  // Gemini Embedding 2 aggregates a list of parts into one content. Explicit
  // content objects remain separate batch items, as in the provider's tContents.
  if (
    params.model.includes("gemini-embedding-2") &&
    contents.length > 0 &&
    contents.every(
      (content): content is string | GoogleGenAIPart =>
        typeof content === "string" ||
        (!Array.isArray(content) && !("parts" in content)),
    )
  ) {
    contents = [contents];
  }
  const input = {
    inputs: contents.map((content) => {
      const parts =
        typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content
            : "parts" in content
              ? content.parts
              : [content];
      const normalized = parts.flatMap((part): EmbeddingContentPart[] => {
        if (typeof part === "string") return [{ type: "text", text: part }];
        if (part.text !== undefined) return [{ type: "text", text: part.text }];
        const media = part.inlineData ?? part.fileData;
        if (!media) return [];
        if ("data" in media && !isAutoCaptureAttachmentsEnabled()) return [];
        const data =
          "data" in media
            ? `data:${media.mimeType};base64,${typeof media.data === "string" ? media.data : uint8ArrayToBase64(media.data)}`
            : media.fileUri;
        return media.mimeType?.startsWith("image/")
          ? [{ type: "image_url", image_url: { url: data } }]
          : [
              {
                type: "file",
                file: {
                  file_data: data,
                  ...("displayName" in media && media.displayName
                    ? { filename: media.displayName }
                    : {}),
                },
              },
            ];
      });
      return {
        content:
          normalized.length === 1 && normalized[0].type === "text"
            ? normalized[0].text
            : normalized,
      };
    }),
    ...(params.config?.outputDimensionality !== undefined
      ? { output_dimensions: params.config.outputDimensionality }
      : {}),
  };
  try {
    const processed: typeof input = processInputAttachments(input);
    // Conversion must succeed for every inline part; otherwise retain the
    // entire original payload for backend attachment processing.
    const hasInlineMedia = processed.inputs.some(
      ({ content }) =>
        Array.isArray(content) &&
        content.some((part) => {
          const data =
            part.type === "image_url"
              ? part.image_url.url
              : part.type === "file"
                ? part.file.file_data
                : undefined;
          return typeof data === "string" && data.startsWith("data:");
        }),
    );
    return hasInlineMedia ? input : processed;
  } catch (error) {
    debugLogger.error(
      "Error processing Google GenAI embedding attachments:",
      error,
    );
    return input;
  }
}

function serializeInteractionInput(
  params: GoogleGenAIInteractionCreateParams,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    input: serializeInteractionValue(params.input),
  };

  for (const key of [
    "model",
    "agent",
    "agent_config",
    "api_version",
    "background",
    "environment",
    "generation_config",
    "previous_interaction_id",
    "response_format",
    "response_mime_type",
    "response_modalities",
    "service_tier",
    "store",
    "stream",
    "system_instruction",
    "webhook_config",
  ]) {
    const value = params[key];
    if (value !== undefined) {
      input[key] = serializeInteractionValue(value);
    }
  }

  return input;
}

function extractInteractionMetadata(
  params: GoogleGenAIInteractionCreateParams,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { provider: "google" };

  for (const key of [
    "model",
    "agent",
    "agent_config",
    "generation_config",
    "system_instruction",
    "response_format",
    "response_mime_type",
    "response_modalities",
    "service_tier",
  ]) {
    const value = params[key];
    if (value !== undefined) {
      metadata[key] = serializeInteractionValue(value);
    }
  }

  if (Array.isArray(params.tools)) {
    metadata.tools = params.tools.map((tool) =>
      serializeInteractionValue(tool),
    );
  }

  return metadata;
}

/**
 * Serialize contents, converting inline data to Attachments.
 */
function serializeContentCollection(
  contents: string | GoogleGenAIContent | GoogleGenAIContent[],
): unknown {
  if (contents === null || contents === undefined) {
    return null;
  }

  if (Array.isArray(contents)) {
    return contents.map((item) => serializeContentItem(item));
  }

  return serializeContentItem(contents);
}

/**
 * Serialize a single content item.
 */
function serializeContentItem(item: string | GoogleGenAIContent): unknown {
  if (typeof item === "object" && item !== null) {
    if (item.parts && Array.isArray(item.parts)) {
      return {
        ...item,
        parts: item.parts
          .map((part: GoogleGenAIPart) => serializePart(part))
          .filter((part) => part !== undefined),
      };
    }
    return item;
  }

  if (typeof item === "string") {
    return { text: item };
  }

  return item;
}

/**
 * Serialize a part, converting inline data to Attachments.
 */
function serializePart(
  part: GoogleGenAIPart,
  captureAttachments = isAutoCaptureAttachmentsEnabled(),
): unknown {
  if (!part || typeof part !== "object") {
    return part;
  }

  if (part.inlineData && !captureAttachments)
    return omitMediaData({
      ...part,
      inlineData: omitMediaData(part.inlineData, "data"),
    });
  if (part.inlineData && part.inlineData.data) {
    const { data, mimeType } = part.inlineData;
    const attachment = createAttachmentFromInlineData(
      data,
      mimeType,
      undefined,
      captureAttachments,
    );

    if (attachment) {
      return mimeType.startsWith("image/")
        ? { image_url: { url: attachment } }
        : {
            file: {
              file_data: attachment,
              filename:
                attachment instanceof Attachment
                  ? attachment.reference.filename
                  : `file.${getExtensionFromMediaType(mimeType)}`,
            },
          };
    }
  }

  return part;
}

function isVideoInteractionCreate(params: unknown): boolean {
  const paramsDict = tryToDict(params);
  if (!paramsDict) {
    return false;
  }

  const responseFormat = tryToDict(paramsDict.response_format);
  return (
    responseFormat?.type === "video" ||
    (typeof paramsDict.model === "string" &&
      paramsDict.model.startsWith("gemini-omni-"))
  );
}

function serializeVideoInteractionInput(
  params: GoogleGenAIInteractionCreateParams,
): Record<string, unknown> {
  const prompt: string[] = [];
  const content: Array<
    | { type: "image_url"; image_url: { url: string | Attachment } }
    | {
        type: "file";
        file: { filename: string; file_data: string | Attachment };
      }
  > = [];

  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      prompt.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }

    const item = tryToDict(value);
    if (!item) {
      return;
    }
    if (item.type === "text" && typeof item.text === "string") {
      prompt.push(item.text);
      return;
    }
    if (Array.isArray(item.content)) {
      collect(item.content);
      return;
    }

    const mimeType =
      typeof item.mime_type === "string"
        ? item.mime_type
        : typeof item.mimeType === "string"
          ? item.mimeType
          : item.type === "video"
            ? "video/mp4"
            : undefined;
    const attachment =
      mimeType && item.data !== undefined
        ? createAttachmentFromInlineData(
            item.data,
            mimeType,
            typeof item.name === "string" ? item.name : undefined,
          )
        : null;
    const media =
      attachment ?? (typeof item.uri === "string" ? item.uri : null);
    if (!media || !mimeType) {
      return;
    }

    if (mimeType.startsWith("image/")) {
      content.push({ type: "image_url", image_url: { url: media } });
    } else {
      content.push({
        type: "file",
        file: {
          filename:
            typeof item.name === "string"
              ? item.name
              : `file.${getExtensionFromMediaType(mimeType)}`,
          file_data: media,
        },
      });
    }
  };
  collect(params.input);

  const responseFormat = tryToDict(params.response_format);
  const generationConfig = tryToDict(params.generation_config);
  const videoConfig = tryToDict(
    generationConfig?.video_config ?? generationConfig?.videoConfig,
  );
  const parameters: Record<string, unknown> = {};
  const aspectRatio =
    responseFormat?.aspect_ratio ?? responseFormat?.aspectRatio;
  const size = responseFormat?.resolution;
  const seed = videoConfig?.seed ?? generationConfig?.seed;
  const outputFormat =
    responseFormat?.mime_type ??
    responseFormat?.mimeType ??
    params.response_mime_type;
  if (aspectRatio !== undefined) parameters.aspect_ratio = aspectRatio;
  if (size !== undefined) parameters.size = size;
  if (seed !== undefined) parameters.seed = seed;
  if (outputFormat !== undefined) parameters.output_format = outputFormat;

  return {
    operation: "generate",
    ...(prompt.length > 0 ? { prompt: prompt.join("\n") } : {}),
    ...(content.length > 0 ? { content } : {}),
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  };
}

function getInteractionVideoOutput(
  response: GoogleGenAIInteraction | undefined,
): GoogleGenAIInteractionContent[] {
  const responseDict = tryToDict(response);
  if (!responseDict) {
    return [];
  }

  const directOutput = tryToDict(responseDict.output_video);
  if (directOutput) {
    return [directOutput];
  }

  if (!Array.isArray(responseDict.steps)) {
    return [];
  }

  return responseDict.steps.flatMap((step) => {
    const stepDict = tryToDict(step);
    const stepContent = Array.isArray(stepDict?.content)
      ? stepDict.content
      : stepDict?.content
        ? [stepDict.content]
        : [];
    return stepContent.flatMap((part) => {
      const partDict = tryToDict(part);
      return partDict?.type === "video" ? [partDict] : [];
    });
  });
}

function serializeVideoInteractionOutput(
  response: GoogleGenAIInteraction | undefined,
): Record<string, unknown> {
  return {
    content: getInteractionVideoOutput(response).flatMap((video, index) => {
      const mimeType =
        typeof video.mime_type === "string"
          ? video.mime_type
          : typeof video.mimeType === "string"
            ? video.mimeType
            : "video/mp4";
      const filename =
        typeof video.name === "string"
          ? video.name
          : `generated-video-${index + 1}.${getExtensionFromMediaType(mimeType)}`;
      const attachment =
        video.data !== undefined
          ? createAttachmentFromInlineData(video.data, mimeType, filename)
          : null;
      const media =
        attachment ?? (typeof video.uri === "string" ? video.uri : null);
      return media
        ? [{ type: "file", file: { filename, file_data: media } }]
        : [];
    }),
  };
}

function serializeInteractionValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeInteractionValue(item, seen));
  }

  const dict: unknown = tryToDict(value);
  if (dict === null || dict === undefined || typeof dict !== "object") {
    return dict;
  }

  if (Array.isArray(dict)) {
    return dict.map((item) => serializeInteractionValue(item, seen));
  }

  if (seen.has(dict)) {
    return "[Circular]";
  }

  seen.add(dict);
  try {
    const serialized: Record<string, unknown> = {};
    const mimeType =
      "mime_type" in dict && typeof dict.mime_type === "string"
        ? dict.mime_type
        : "mimeType" in dict && typeof dict.mimeType === "string"
          ? dict.mimeType
          : undefined;
    const captureAttachments = isAutoCaptureAttachmentsEnabled();
    const attachment =
      captureAttachments &&
      mimeType &&
      "data" in dict &&
      dict.data !== undefined
        ? createAttachmentFromInlineData(dict.data, mimeType)
        : null;

    for (const key of Object.keys(dict)) {
      if (key === "data" && mimeType && !captureAttachments) continue;
      const entry: unknown = Reflect.get(dict, key);
      if (key === "data" && attachment) {
        serialized[key] = attachment;
      } else {
        serialized[key] = serializeInteractionValue(entry, seen);
      }
    }

    return serialized;
  } finally {
    seen.delete(dict);
  }
}

function createAttachmentFromInlineData(
  data: unknown,
  mimeType?: string,
  filename?: string,
  captureAttachments = isAutoCaptureAttachmentsEnabled(),
): Attachment | null {
  if (!captureAttachments) return null;
  if (
    !(
      data instanceof Uint8Array ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) ||
      typeof data === "string"
    )
  ) {
    return null;
  }

  const buffer =
    typeof data === "string"
      ? typeof Buffer !== "undefined"
        ? Buffer.from(data, "base64")
        : new Uint8Array(
            atob(data)
              .split("")
              .map((c) => c.charCodeAt(0)),
          )
      : typeof Buffer !== "undefined"
        ? Buffer.from(data)
        : new Uint8Array(data);
  const arrayBuffer =
    buffer instanceof Uint8Array
      ? buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        )
      : buffer;

  return new Attachment({
    data: arrayBuffer,
    filename:
      filename ??
      `file.${mimeType ? getExtensionFromMediaType(mimeType) : "bin"}`,
    contentType: mimeType || "application/octet-stream",
  });
}

function serializeGenerateContentTools(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown>[] | null {
  const config = params.config ? tryToDict(params.config) : null;
  const tools = config?.tools;
  if (!Array.isArray(tools)) {
    return null;
  }

  try {
    const serializedTools: Record<string, unknown>[] = [];
    for (const tool of tools) {
      const toolDict = tryToDict(tool);
      if (toolDict) {
        serializedTools.push(toolDict);
      }
    }
    return serializedTools.length > 0 ? serializedTools : null;
  } catch {
    return null;
  }
}

function extractGenerateContentMetadata(
  params: GoogleGenAIGenerateContentParams,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (params.model) {
    metadata.model = params.model;
  }

  if (params.config) {
    const config = tryToDict(params.config);
    if (config) {
      Object.keys(config).forEach((key) => {
        if (key !== "tools") {
          metadata[key] = config[key];
        }
      });
    }
  }

  const tools = serializeGenerateContentTools(params);
  if (tools) {
    metadata.tools = tools;
  }

  return metadata;
}

/**
 * Extract metrics from non-streaming generateContent response.
 */
function extractGenerateContentMetrics(
  response: GoogleGenAIGenerateContentResponse | undefined,
  startTime?: number,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (startTime !== undefined) {
    const end = getCurrentUnixTimestamp();
    metrics.start = startTime;
    metrics.end = end;
    metrics.duration = end - startTime;
  }

  if (response?.usageMetadata) {
    populateUsageMetrics(metrics, response.usageMetadata);
  }

  return metrics;
}

function extractEmbedContentMetrics(
  response: GoogleGenAIEmbedContentResponse | undefined,
  startTime?: number,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (startTime !== undefined) {
    const end = getCurrentUnixTimestamp();
    metrics.start = startTime;
    metrics.end = end;
  }

  const embeddingTokenCount = extractEmbedPromptTokenCount(response);
  if (embeddingTokenCount !== undefined) {
    metrics.prompt_tokens = embeddingTokenCount;
  }
  const totalTokens =
    response?.usageMetadata?.totalTokenCount ?? embeddingTokenCount;
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  }
  const audioTokens = (
    response?.usageMetadata?.promptTokenDetails ??
    response?.usageMetadata?.promptTokensDetails
  )?.filter(
    (detail) => detail.modality === "AUDIO" && detail.tokenCount !== undefined,
  );
  if (audioTokens?.length) {
    metrics.prompt_audio_tokens = audioTokens.reduce(
      (sum, detail) => sum + (detail.tokenCount ?? 0),
      0,
    );
  }

  return metrics;
}

function extractInteractionMetrics(
  response: GoogleGenAIInteraction | undefined,
  startTime?: number,
): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (startTime !== undefined) {
    const end = getCurrentUnixTimestamp();
    metrics.start = startTime;
    metrics.end = end;
    metrics.duration = end - startTime;
  }

  if (response?.usage) {
    populateInteractionUsageMetrics(metrics, response.usage);
  }

  return metrics;
}

function extractInteractionResponseMetadata(
  response: GoogleGenAIInteraction | undefined,
): Record<string, unknown> | undefined {
  const responseDict = tryToDict(response);
  if (!responseDict) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  if (typeof responseDict.id === "string") {
    metadata.interaction_id = responseDict.id;
  }
  if (typeof responseDict.status === "string") {
    metadata.status = responseDict.status;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractEmbedPromptTokenCount(
  response: GoogleGenAIEmbedContentResponse | undefined,
): number | undefined {
  if (!response) {
    return undefined;
  }

  // Older Vertex models report usage on individual embedding statistics.
  const usagePromptTokens = response.usageMetadata?.promptTokenCount;
  if (
    typeof usagePromptTokens === "number" &&
    Number.isFinite(usagePromptTokens)
  ) {
    return usagePromptTokens;
  }

  const embeddings = Array.isArray(response.embeddings)
    ? response.embeddings
    : response.embedding
      ? [response.embedding]
      : [];
  if (embeddings.length === 0) {
    return undefined;
  }

  let total = 0;
  for (const embedding of embeddings) {
    const embeddingStats = tryToDict(tryToDict(embedding)?.statistics);
    const tokenCount = embeddingStats?.tokenCount;
    if (typeof tokenCount === "number" && Number.isFinite(tokenCount)) {
      total += tokenCount;
    } else {
      return undefined;
    }
  }

  return total;
}

function summarizeEmbedContentOutput(
  response: GoogleGenAIEmbedContentResponse | undefined,
): Record<string, number> {
  return {
    count: Array.isArray(response?.embeddings)
      ? response.embeddings.length
      : response?.embedding
        ? 1
        : 0,
  };
}

function populateUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleGenAIUsageMetadata,
): void {
  if (
    usage.promptTokenCount !== undefined ||
    usage.toolUsePromptTokenCount !== undefined
  ) {
    metrics.prompt_tokens =
      (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0);
  }
  if (
    usage.candidatesTokenCount !== undefined ||
    usage.thoughtsTokenCount !== undefined
  ) {
    metrics.completion_tokens =
      (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  }
  if (usage.totalTokenCount !== undefined) {
    metrics.tokens = usage.totalTokenCount;
  }
  if (usage.cachedContentTokenCount !== undefined) {
    metrics.prompt_cached_tokens = usage.cachedContentTokenCount;
  }
  if (usage.thoughtsTokenCount !== undefined) {
    metrics.completion_reasoning_tokens = usage.thoughtsTokenCount;
  }
  for (const detail of usage.promptTokensDetails ?? []) {
    if (detail.modality === "AUDIO" && detail.tokenCount !== undefined) {
      metrics.prompt_audio_tokens =
        (metrics.prompt_audio_tokens ?? 0) + detail.tokenCount;
    }
  }
  for (const detail of usage.candidatesTokensDetails ?? []) {
    if (detail.modality === "AUDIO" && detail.tokenCount !== undefined) {
      metrics.completion_audio_tokens =
        (metrics.completion_audio_tokens ?? 0) + detail.tokenCount;
    }
    if (detail.modality === "IMAGE" && detail.tokenCount !== undefined) {
      metrics.completion_image_tokens =
        (metrics.completion_image_tokens ?? 0) + detail.tokenCount;
    }
  }
}

function populateInteractionUsageMetrics(
  metrics: Record<string, number>,
  usage: GoogleGenAIInteractionUsage,
): void {
  if (typeof usage.total_input_tokens === "number") {
    metrics.prompt_tokens = usage.total_input_tokens;
  }
  if (typeof usage.total_output_tokens === "number") {
    metrics.completion_tokens =
      usage.total_output_tokens +
      (typeof usage.total_thought_tokens === "number"
        ? usage.total_thought_tokens
        : 0);
  }
  if (typeof usage.total_tokens === "number") {
    metrics.tokens = usage.total_tokens;
  }
  if (typeof usage.total_cached_tokens === "number") {
    metrics.prompt_cached_tokens = usage.total_cached_tokens;
  }
  if (typeof usage.total_thought_tokens === "number") {
    metrics.completion_reasoning_tokens = usage.total_thought_tokens;
  }

  for (const detail of Array.isArray(usage.input_tokens_by_modality)
    ? usage.input_tokens_by_modality
    : []) {
    if (
      typeof detail?.modality === "string" &&
      detail.modality.toLowerCase() === "audio" &&
      typeof detail.tokens === "number"
    ) {
      metrics.prompt_audio_tokens =
        (metrics.prompt_audio_tokens ?? 0) + detail.tokens;
    }
  }

  for (const detail of Array.isArray(usage.output_tokens_by_modality)
    ? usage.output_tokens_by_modality
    : []) {
    if (
      typeof detail?.modality !== "string" ||
      typeof detail.tokens !== "number"
    ) {
      continue;
    }

    switch (detail.modality.toLowerCase()) {
      case "audio":
        metrics.completion_audio_tokens =
          (metrics.completion_audio_tokens ?? 0) + detail.tokens;
        break;
      case "image":
        metrics.completion_image_tokens =
          (metrics.completion_image_tokens ?? 0) + detail.tokens;
        break;
    }
  }
}

/**
 * Aggregate chunks from streaming generateContentStream response.
 */
function aggregateGenerateContentChunks(
  chunks: GoogleGenAIGenerateContentResponse[],
  startTime: number,
  firstTokenTime: number | null,
  captureAttachments: boolean,
): {
  aggregated: Record<string, unknown>;
  metrics: Record<string, number>;
} {
  const end = getCurrentUnixTimestamp();
  const metrics: Record<string, number> = {
    start: startTime,
    end,
    duration: end - startTime,
  };

  if (firstTokenTime !== null) {
    metrics.time_to_first_token = firstTokenTime - startTime;
  }

  if (chunks.length === 0) {
    return { aggregated: {}, metrics };
  }

  let text = "";
  let thoughtText = "";
  const otherParts: Record<string, unknown>[] = [];
  let groundingMetadata: unknown = undefined;
  let usageMetadata: GoogleGenAIUsageMetadata | null = null;
  let lastResponse: GoogleGenAIGenerateContentResponse | null = null;

  for (const chunk of chunks) {
    lastResponse = chunk;

    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata;
    }
    if (chunk.groundingMetadata !== undefined) {
      groundingMetadata = chunk.groundingMetadata;
    }

    if (chunk.candidates && Array.isArray(chunk.candidates)) {
      for (const candidate of chunk.candidates) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined) {
              if (part.thought) {
                thoughtText += part.text;
              } else {
                text += part.text;
              }
            } else if (part.functionCall) {
              otherParts.push({ functionCall: part.functionCall });
            } else if (part.codeExecutionResult) {
              otherParts.push({
                codeExecutionResult: part.codeExecutionResult,
              });
            } else if (part.executableCode) {
              otherParts.push({ executableCode: part.executableCode });
            } else if (part.inlineData || part.fileData) {
              const serializedPart = tryToDict(
                serializePart(part, captureAttachments),
              );
              if (serializedPart) {
                otherParts.push(serializedPart);
              }
            }
          }
        }
      }
    }
  }

  const aggregated: Record<string, unknown> = {};

  const parts: Record<string, unknown>[] = [];
  if (thoughtText) {
    parts.push({ text: thoughtText, thought: true });
  }
  if (text) {
    parts.push({ text });
  }
  parts.push(...otherParts);

  if (parts.length > 0 && lastResponse?.candidates) {
    const candidates: Record<string, unknown>[] = [];
    for (const candidate of lastResponse.candidates) {
      const candidateDict: Record<string, unknown> = {
        content: {
          parts,
          role: "model",
        },
      };

      if (candidate.finishReason !== undefined) {
        candidateDict.finishReason = candidate.finishReason;
      }
      if (candidate.groundingMetadata !== undefined) {
        candidateDict.groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata === undefined) {
          groundingMetadata = candidate.groundingMetadata;
        }
      }
      if (candidate.safetyRatings) {
        candidateDict.safetyRatings = candidate.safetyRatings;
      }

      candidates.push(candidateDict);
    }
    aggregated.candidates = candidates;
  }

  if (usageMetadata) {
    aggregated.usageMetadata = usageMetadata;
    populateUsageMetrics(metrics, usageMetadata);
  }
  if (groundingMetadata !== undefined) {
    aggregated.groundingMetadata = groundingMetadata;
  }

  if (text) {
    aggregated.text = text;
  }

  return { aggregated, metrics };
}

function aggregateInteractionEvents(
  chunks: GoogleGenAIInteractionSSEEvent[],
  startTime?: number,
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  const end = getCurrentUnixTimestamp();
  const metrics: Record<string, number> = {};
  if (startTime !== undefined) {
    metrics.start = startTime;
    metrics.end = end;
    metrics.duration = end - startTime;
  }

  let latestInteraction: Record<string, unknown> | undefined;
  let latestUsage: GoogleGenAIInteractionUsage | undefined;
  let status: string | undefined;
  let outputText = "";
  const steps = new Map<number, Record<string, unknown>>();

  for (const chunk of chunks) {
    const event = tryToDict(chunk);
    if (!event) {
      continue;
    }

    const usage = extractInteractionUsageFromEvent(event);
    if (usage) {
      latestUsage = usage;
    }

    const interaction = tryToDict(event.interaction);
    if (interaction) {
      latestInteraction = serializeInteractionValue(interaction) as Record<
        string,
        unknown
      >;
      if (typeof interaction.status === "string") {
        status = interaction.status;
      }
    }

    if (typeof event.status === "string") {
      status = event.status;
    }

    const index = typeof event.index === "number" ? event.index : undefined;
    if (index === undefined) {
      continue;
    }

    if (event.event_type === "step.start") {
      const compact = compactInteractionStep(event.step);
      compact.index = index;
      steps.set(index, compact);
      continue;
    }

    if (event.event_type === "step.delta") {
      const step = steps.get(index) ?? { index };
      const textDelta = applyInteractionDelta(step, event.delta);
      if (textDelta) {
        outputText += textDelta;
      }
      steps.set(index, step);
    }
  }

  if (latestUsage) {
    populateInteractionUsageMetrics(metrics, latestUsage);
  }

  const output: Record<string, unknown> = latestInteraction
    ? { ...latestInteraction }
    : {};
  if (status) {
    output.status = status;
  }
  if (outputText) {
    output.output_text = outputText;
  }
  if (latestUsage) {
    output.usage = serializeInteractionValue(latestUsage);
  }

  const compactSteps = Array.from(steps.values()).sort(
    (left, right) => Number(left.index ?? 0) - Number(right.index ?? 0),
  );
  if (compactSteps.length > 0) {
    output.steps = compactSteps;
  }

  const metadata: Record<string, unknown> = {};
  if (typeof output.id === "string") {
    metadata.interaction_id = output.id;
  }
  if (typeof output.status === "string") {
    metadata.status = output.status;
  }

  return {
    output,
    metrics: cleanMetrics(metrics),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function extractInteractionUsageFromEvent(
  event: Record<string, unknown>,
): GoogleGenAIInteractionUsage | undefined {
  const metadata = tryToDict(event.metadata);
  const metadataUsage = tryToDict(metadata?.usage);
  if (metadataUsage) {
    return metadataUsage as GoogleGenAIInteractionUsage;
  }
  const metadataTotalUsage = tryToDict(metadata?.total_usage);
  if (metadataTotalUsage) {
    return metadataTotalUsage as GoogleGenAIInteractionUsage;
  }

  const interaction = tryToDict(event.interaction);
  const interactionUsage = tryToDict(interaction?.usage);
  return interactionUsage
    ? (interactionUsage as GoogleGenAIInteractionUsage)
    : undefined;
}

function compactInteractionStep(step: unknown): Record<string, unknown> {
  const stepDict = tryToDict(step);
  if (!stepDict) {
    return {};
  }

  const compact: Record<string, unknown> = {};
  for (const key of [
    "type",
    "content",
    "name",
    "server_name",
    "arguments",
    "result",
    "is_error",
  ]) {
    if (stepDict[key] !== undefined) {
      compact[key] = serializeInteractionValue(stepDict[key]);
    }
  }

  return Object.keys(compact).length > 0
    ? compact
    : (serializeInteractionValue(stepDict) as Record<string, unknown>);
}

function applyInteractionDelta(
  step: Record<string, unknown>,
  delta: unknown,
): string | undefined {
  const deltaDict = tryToDict(delta);
  if (!deltaDict) {
    return undefined;
  }

  const deltaType = deltaDict.type;
  if (typeof deltaType === "string" && typeof step.type !== "string") {
    step.type = deltaType === "text" ? "model_output" : deltaType;
  }

  if (deltaType === "text" && typeof deltaDict.text === "string") {
    step.text = `${typeof step.text === "string" ? step.text : ""}${
      deltaDict.text
    }`;
    return deltaDict.text;
  }

  if (
    deltaType === "arguments_delta" &&
    typeof deltaDict.arguments === "string"
  ) {
    step.arguments = `${
      typeof step.arguments === "string" ? step.arguments : ""
    }${deltaDict.arguments}`;
    return undefined;
  }

  const deltas = Array.isArray(step.deltas) ? step.deltas : [];
  deltas.push(serializeInteractionValue(deltaDict));
  step.deltas = deltas;
  return undefined;
}

function cleanMetrics(metrics: Record<string, number>): Record<string, number> {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function extractResponseMetadata(
  response: unknown,
): Record<string, unknown> | undefined {
  const responseDict = tryToDict(response);
  if (!responseDict) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  const responseGroundingMetadata = responseDict.groundingMetadata;
  const candidateGroundingMetadata: unknown[] = [];

  if (Array.isArray(responseDict.candidates)) {
    for (const candidate of responseDict.candidates) {
      const candidateDict = tryToDict(candidate);
      if (candidateDict?.groundingMetadata !== undefined) {
        candidateGroundingMetadata.push(candidateDict.groundingMetadata);
      }
    }
  }

  if (responseGroundingMetadata !== undefined) {
    metadata.groundingMetadata = responseGroundingMetadata;
  } else if (candidateGroundingMetadata.length === 1) {
    [metadata.groundingMetadata] = candidateGroundingMetadata;
  } else if (candidateGroundingMetadata.length > 1) {
    metadata.groundingMetadata = candidateGroundingMetadata;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Helper to convert objects to dictionaries.
 */
function tryToDict(obj: unknown): Record<string, unknown> | null {
  if (obj === null || obj === undefined) {
    return null;
  }

  if (typeof obj === "object") {
    if (
      "toJSON" in obj &&
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      typeof (obj as Record<string, unknown>).toJSON === "function"
    ) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return (obj as { toJSON: () => Record<string, unknown> }).toJSON();
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return obj as Record<string, unknown>;
  }

  return null;
}
