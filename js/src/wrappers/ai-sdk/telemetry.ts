import {
  SpanTypeAttribute,
  getCurrentUnixTimestamp,
  isObject,
} from "../../util";
import { logError, startSpan, withCurrent, type Span } from "../../logger";
import {
  createAISDKIntegrationMetadata,
  DEFAULT_DENY_OUTPUT_PATHS,
  extractTokenMetrics,
  processAISDKCallInput,
  processAISDKEmbeddingOutput,
  processAISDKOutput,
  processAISDKRerankOutput,
  serializeModelWithProvider,
} from "../../instrumentation/plugins/ai-sdk-plugin";
import type {
  AISDKCallParams,
  AISDKEmbeddingResult,
  AISDKModel,
  AISDKResult,
  AISDKRerankResult,
} from "../../vendor-sdk-types/ai-sdk";
import type {
  AISDKV7LanguageModelCallStartEvent,
  AISDKV7OperationEvent,
  AISDKV7Telemetry,
  AISDKV7TelemetryOptions,
} from "../../vendor-sdk-types/ai-sdk-v7-telemetry";

type OperationState = {
  firstChunkTime?: number;
  hadModelChild: boolean;
  operationName: string;
  span: Span;
  startTime: number;
};

type CallSpanState = {
  callId: string;
  span: Span;
};

type EmbedSpanState = CallSpanState & {
  values: unknown[];
};

/**
 * Creates a Braintrust telemetry integration for AI SDK v7's
 * `registerTelemetry()` API.
 */
export function braintrustAISDKTelemetry(): AISDKV7Telemetry {
  const operations = new Map<string, OperationState>();
  const modelSpans = new Map<string, Span[]>();
  const objectSpans = new Map<string, Span>();
  const embedSpans = new Map<string, EmbedSpanState>();
  const rerankSpans = new Map<string, Span>();
  const toolSpans = new Map<string, CallSpanState>();

  const runSafely = (name: string, callback: () => void) => {
    try {
      callback();
    } catch (error) {
      // eslint-disable-next-line no-restricted-properties
      console.error(`Error in Braintrust AI SDK telemetry ${name}:`, error);
    }
  };

  const startChildSpan = (
    callId: string,
    name: string,
    type: SpanTypeAttribute,
    event?: { input?: unknown; metadata?: Record<string, unknown> },
  ) => {
    const parent = operations.get(callId)?.span;
    const spanArgs = {
      name,
      spanAttributes: { type },
      ...(event ? { event } : {}),
    };
    const span = parent ? parent.startSpan(spanArgs) : startSpan(spanArgs);
    const state = operations.get(callId);
    if (state && type === SpanTypeAttribute.LLM) {
      state.hadModelChild = true;
    }
    return span;
  };

  return {
    onStart(event) {
      runSafely("onStart", () => {
        const operationName = operationNameFromId(event.operationId);
        const span = startSpan({
          name: operationName,
          spanAttributes: { type: SpanTypeAttribute.FUNCTION },
        });

        operations.set(event.callId, {
          hadModelChild: false,
          operationName,
          span,
          startTime: getCurrentUnixTimestamp(),
        });

        const metadata = metadataFromEvent(event);
        const logPayload: {
          input?: unknown;
          metadata: Record<string, unknown>;
        } = { metadata };

        if (shouldRecordInputs(event)) {
          const { input, outputPromise } = processAISDKCallInput(
            operationInput(event, operationName),
          );
          logPayload.input = input;
          if (outputPromise && input && typeof input === "object") {
            outputPromise
              .then((resolvedData) => {
                span.log({
                  input: {
                    ...(input as Record<string, unknown>),
                    ...resolvedData,
                  },
                });
              })
              .catch(() => {
                // Keep the placeholder response_format if async resolution fails.
              });
          }
        }

        span.log(logPayload);
      });
    },

    onLanguageModelCallStart(event) {
      runSafely("onLanguageModelCallStart", () => {
        const state = operations.get(event.callId);
        const openSpans = modelSpans.get(event.callId);
        if (openSpans) {
          for (const span of openSpans) {
            span.end();
          }
          modelSpans.delete(event.callId);
        }

        const span = startChildSpan(
          event.callId,
          state?.operationName === "streamText" ? "doStream" : "doGenerate",
          SpanTypeAttribute.LLM,
          {
            ...(shouldRecordInputs(event)
              ? {
                  input: processAISDKCallInput(
                    operationInput(
                      event,
                      state?.operationName ?? "generateText",
                    ),
                  ).input,
                }
              : {}),
            metadata: metadataFromEvent(event),
          },
        );
        const spans = modelSpans.get(event.callId) ?? [];
        spans.push(span);
        modelSpans.set(event.callId, spans);
      });
    },

    onLanguageModelCallEnd(event) {
      runSafely("onLanguageModelCallEnd", () => {
        const span = shiftModelSpan(modelSpans, event.callId);
        if (!span) {
          return;
        }

        const result = {
          ...event,
          response: event.responseId ? { id: event.responseId } : undefined,
        } as AISDKResult;
        span.log({
          ...(shouldRecordOutputs(event)
            ? {
                output: processAISDKOutput(result, DEFAULT_DENY_OUTPUT_PATHS),
              }
            : {}),
          metrics: extractTokenMetrics(result),
        });
        span.end();
      });
    },

    onObjectStepStart(event) {
      runSafely("onObjectStepStart", () => {
        const state = operations.get(event.callId);
        const openSpan = objectSpans.get(event.callId);
        if (openSpan) {
          openSpan.end();
          objectSpans.delete(event.callId);
        }

        const span = startChildSpan(
          event.callId,
          state?.operationName === "streamObject" ? "doStream" : "doGenerate",
          SpanTypeAttribute.LLM,
          {
            ...(shouldRecordInputs(event)
              ? {
                  input: {
                    prompt: event.promptMessages,
                  },
                }
              : {}),
            metadata: metadataFromEvent(event),
          },
        );
        objectSpans.set(event.callId, span);
      });
    },

    onObjectStepFinish(event) {
      runSafely("onObjectStepFinish", () => {
        const span = objectSpans.get(event.callId);
        if (!span) {
          return;
        }

        const result = {
          ...event,
          text: event.objectText,
        } as AISDKResult;
        span.log({
          ...(shouldRecordOutputs(event)
            ? {
                output: processAISDKOutput(result, DEFAULT_DENY_OUTPUT_PATHS),
              }
            : {}),
          metrics: extractTokenMetrics(result),
        });
        span.end();
        objectSpans.delete(event.callId);
      });
    },

    onEmbedStart(event) {
      runSafely("onEmbedStart", () => {
        const state = operations.get(event.callId);
        for (const [embedCallId, embedState] of embedSpans) {
          if (
            embedState.callId === event.callId &&
            (state?.operationName === "embed" ||
              embedState.values === event.values)
          ) {
            embedState.span.end();
            embedSpans.delete(embedCallId);
          }
        }

        const span = startChildSpan(
          event.callId,
          "doEmbed",
          SpanTypeAttribute.LLM,
          {
            ...(shouldRecordInputs(event)
              ? {
                  input: {
                    values: event.values,
                  },
                }
              : {}),
            metadata: metadataFromEvent(event),
          },
        );
        embedSpans.set(event.embedCallId, {
          callId: event.callId,
          span,
          values: event.values,
        });
      });
    },

    onEmbedFinish(event) {
      runSafely("onEmbedFinish", () => {
        const state = embedSpans.get(event.embedCallId);
        if (!state) {
          return;
        }

        const result = {
          ...event,
          embeddings: event.embeddings,
        } as AISDKEmbeddingResult;
        state.span.log({
          ...(shouldRecordOutputs(event)
            ? {
                output: processAISDKEmbeddingOutput(
                  result,
                  DEFAULT_DENY_OUTPUT_PATHS,
                ),
              }
            : {}),
          metrics: extractTokenMetrics(result),
        });
        state.span.end();
        embedSpans.delete(event.embedCallId);
      });
    },

    onRerankStart(event) {
      runSafely("onRerankStart", () => {
        const openSpan = rerankSpans.get(event.callId);
        if (openSpan) {
          openSpan.end();
          rerankSpans.delete(event.callId);
        }

        const span = startChildSpan(
          event.callId,
          "doRerank",
          SpanTypeAttribute.LLM,
          {
            ...(shouldRecordInputs(event)
              ? {
                  input: {
                    documents: event.documents,
                    query: event.query,
                    topN: event.topN,
                  },
                }
              : {}),
            metadata: metadataFromEvent(event),
          },
        );
        rerankSpans.set(event.callId, span);
      });
    },

    onRerankFinish(event) {
      runSafely("onRerankFinish", () => {
        const span = rerankSpans.get(event.callId);
        if (!span) {
          return;
        }

        const result = {
          ranking: event.ranking?.map((entry) => ({
            originalIndex: entry.index,
            score: entry.relevanceScore,
          })),
        } as AISDKRerankResult;
        span.log({
          ...(shouldRecordOutputs(event)
            ? {
                output: processAISDKRerankOutput(
                  result,
                  DEFAULT_DENY_OUTPUT_PATHS,
                ),
              }
            : {}),
        });
        span.end();
        rerankSpans.delete(event.callId);
      });
    },

    onToolExecutionStart(event) {
      runSafely("onToolExecutionStart", () => {
        const toolCallId = event.toolCall.toolCallId;
        if (!toolCallId) {
          return;
        }

        const span = startChildSpan(
          event.callId,
          event.toolCall.toolName || "tool",
          SpanTypeAttribute.TOOL,
          {
            ...(shouldRecordInputs(event)
              ? {
                  input: event.toolCall.input,
                }
              : {}),
            metadata: {
              ...createAISDKIntegrationMetadata(),
              toolCallId,
              ...(typeof event.toolCall.toolName === "string"
                ? { toolName: event.toolCall.toolName }
                : {}),
            },
          },
        );
        toolSpans.set(toolCallId, { callId: event.callId, span });
      });
    },

    onToolExecutionEnd(event) {
      runSafely("onToolExecutionEnd", () => {
        const toolCallId = event.toolCall.toolCallId;
        const state = toolCallId ? toolSpans.get(toolCallId) : undefined;
        if (!toolCallId || !state) {
          return;
        }

        const toolOutput = event.toolOutput;
        if (toolOutput?.type === "tool-error") {
          state.span.log({
            error:
              toolOutput.error instanceof Error
                ? toolOutput.error.message
                : String(toolOutput?.error),
            metrics:
              typeof event.durationMs === "number"
                ? { duration_ms: event.durationMs }
                : {},
          });
        } else {
          state.span.log({
            ...(shouldRecordOutputs(event)
              ? { output: toolOutput?.output }
              : {}),
            metrics:
              typeof event.durationMs === "number"
                ? { duration_ms: event.durationMs }
                : {},
          });
        }
        state.span.end();
        toolSpans.delete(toolCallId);
      });
    },

    onChunk(event) {
      runSafely("onChunk", () => {
        const callId = event.chunk?.callId;
        if (!callId) {
          return;
        }
        const state = operations.get(callId);
        if (!state || state.firstChunkTime !== undefined) {
          return;
        }
        state.firstChunkTime = getCurrentUnixTimestamp();
      });
    },

    onFinish(event) {
      runSafely("onFinish", () => {
        const state = operations.get(event.callId);
        if (!state) {
          return;
        }

        const result = finishResult(event, state.operationName);
        const metrics: Record<string, number> = state.hadModelChild
          ? {}
          : extractTokenMetrics(result);
        if (state.firstChunkTime !== undefined) {
          metrics.time_to_first_token = state.firstChunkTime - state.startTime;
        }

        state.span.log({
          ...(shouldRecordOutputs(event)
            ? {
                output: finishOutput(result, state.operationName),
              }
            : {}),
          metrics,
        });
        state.span.end();
        operations.delete(event.callId);
      });
    },

    onError(event) {
      runSafely("onError", () => {
        const errorEvent = isObject(event)
          ? (event as { callId?: unknown; error?: unknown })
          : {};
        const callId =
          typeof errorEvent.callId === "string" ? errorEvent.callId : undefined;
        if (!callId) {
          return;
        }

        const state = operations.get(callId);
        if (!state) {
          return;
        }
        const error = errorEvent.error ?? event;

        const openModelSpans = modelSpans.get(callId);
        if (openModelSpans) {
          for (const span of openModelSpans) {
            logError(span, error);
            span.end();
          }
          modelSpans.delete(callId);
        }

        const openObjectSpan = objectSpans.get(callId);
        if (openObjectSpan) {
          logError(openObjectSpan, error);
          openObjectSpan.end();
          objectSpans.delete(callId);
        }

        for (const [embedCallId, embedState] of embedSpans) {
          if (embedState.callId === callId) {
            logError(embedState.span, error);
            embedState.span.end();
            embedSpans.delete(embedCallId);
          }
        }

        const openRerankSpan = rerankSpans.get(callId);
        if (openRerankSpan) {
          logError(openRerankSpan, error);
          openRerankSpan.end();
          rerankSpans.delete(callId);
        }

        for (const [toolCallId, toolState] of toolSpans) {
          if (toolState.callId === callId) {
            logError(toolState.span, error);
            toolState.span.end();
            toolSpans.delete(toolCallId);
          }
        }

        logError(state.span, error);
        state.span.end();
        operations.delete(callId);
      });
    },

    executeTool({ toolCallId, execute }) {
      const state = toolSpans.get(toolCallId);
      return state ? withCurrent(state.span, () => execute()) : execute();
    },
  };
}

function shouldRecordInputs(event: AISDKV7TelemetryOptions): boolean {
  return event.recordInputs !== false;
}

function shouldRecordOutputs(event: AISDKV7TelemetryOptions): boolean {
  return event.recordOutputs !== false;
}

function operationNameFromId(operationId: string | undefined): string {
  return operationId?.startsWith("ai.")
    ? operationId.slice("ai.".length)
    : operationId || "ai-sdk";
}

function modelFromEvent(event: {
  modelId?: string;
  provider?: string;
}): AISDKModel | undefined {
  return event.modelId
    ? {
        modelId: event.modelId,
        ...(event.provider ? { provider: event.provider } : {}),
      }
    : undefined;
}

function metadataFromEvent(
  event: AISDKV7TelemetryOptions & { modelId?: string; provider?: string },
): Record<string, unknown> {
  const metadata = createAISDKIntegrationMetadata();
  const { model, provider } = serializeModelWithProvider(modelFromEvent(event));
  if (model) {
    metadata.model = model;
  }
  if (provider) {
    metadata.provider = provider;
  }
  if (typeof event.functionId === "string") {
    metadata.functionId = event.functionId;
  }
  return metadata;
}

function operationInput(
  event: AISDKV7OperationEvent | AISDKV7LanguageModelCallStartEvent,
  operationName: string,
): AISDKCallParams {
  if (operationName === "embed") {
    return {
      model: modelFromEvent(event),
      value: (event as { value?: unknown }).value,
    };
  }

  if (operationName === "embedMany") {
    return {
      model: modelFromEvent(event),
      values: Array.isArray((event as { value?: unknown }).value)
        ? ((event as { value?: unknown[] }).value ?? [])
        : undefined,
    };
  }

  if (operationName === "rerank") {
    return {
      model: modelFromEvent(event),
      documents: (event as { documents?: unknown[] }).documents,
      query: (event as { query?: string }).query,
      topN: (event as { topN?: number }).topN,
    };
  }

  return {
    model: modelFromEvent(event),
    system: event.system,
    prompt: event.prompt,
    messages: event.messages,
    tools: event.tools,
    toolChoice: event.toolChoice,
    activeTools: event.activeTools,
    output: event.output,
    schema: event.schema,
    schemaName: event.schemaName,
    schemaDescription: event.schemaDescription,
    maxOutputTokens: event.maxOutputTokens,
    temperature: event.temperature,
    topP: event.topP,
    topK: event.topK,
    presencePenalty: event.presencePenalty,
    frequencyPenalty: event.frequencyPenalty,
    seed: event.seed,
    maxRetries: event.maxRetries,
    headers: event.headers,
    providerOptions: event.providerOptions,
  } as AISDKCallParams;
}

function shiftModelSpan(
  modelSpans: Map<string, Span[]>,
  callId: string,
): Span | undefined {
  const spans = modelSpans.get(callId);
  const span = spans?.shift();
  if (spans && spans.length === 0) {
    modelSpans.delete(callId);
  }
  return span;
}

function finishResult(
  event: AISDKV7OperationEvent,
  operationName: string,
): AISDKResult | AISDKEmbeddingResult | AISDKRerankResult {
  if (operationName === "embed") {
    return {
      ...event,
      embedding: (event as { embedding?: unknown }).embedding,
    } as AISDKEmbeddingResult;
  }

  if (operationName === "embedMany") {
    return {
      ...event,
      embeddings: (event as { embedding?: unknown }).embedding,
    } as AISDKEmbeddingResult;
  }

  if (operationName === "rerank") {
    return event as AISDKRerankResult;
  }

  return event as AISDKResult;
}

function finishOutput(
  result: AISDKResult | AISDKEmbeddingResult | AISDKRerankResult,
  operationName: string,
): unknown {
  if (operationName === "embed" || operationName === "embedMany") {
    return processAISDKEmbeddingOutput(
      result as AISDKEmbeddingResult,
      DEFAULT_DENY_OUTPUT_PATHS,
    );
  }

  if (operationName === "rerank") {
    return processAISDKRerankOutput(
      result as AISDKRerankResult,
      DEFAULT_DENY_OUTPUT_PATHS,
    );
  }

  return processAISDKOutput(result as AISDKResult, DEFAULT_DENY_OUTPUT_PATHS);
}
