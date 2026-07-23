import {
  SpanTypeAttribute,
  getCurrentUnixTimestamp,
  isObject,
} from "../../util";
import { logError, startSpan, withCurrent, type Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import {
  createAISDKIntegrationMetadata,
  DEFAULT_DENY_OUTPUT_PATHS,
  extractWorkflowMetadataFromCallParams,
  extractTokenMetrics,
  processAISDKCallInput,
  processAISDKEmbeddingOutput,
  processAISDKOutput,
  processAISDKRerankOutput,
  processAISDKWorkflowAgentCallInput,
  processAISDKWorkflowAgentModelCallInput,
  serializeModelWithProvider,
} from "../../instrumentation/plugins/ai-sdk-plugin";
import type {
  AISDKCallParams,
  AISDKEmbeddingResult,
  AISDKModel,
  AISDKResult,
  AISDKRerankResult,
} from "../../vendor-sdk-types/ai-sdk";
import iso from "../../isomorph";
import type {
  AISDKV7LanguageModelCallStartEvent,
  AISDKV7OperationEvent,
  AISDKV7Telemetry,
  AISDKV7TelemetryOptions,
} from "../../vendor-sdk-types/ai-sdk-v7-telemetry";
import { BRAINTRUST_AI_SDK_V7_OPERATION_KEY as AI_SDK_V7_OPERATION_KEY } from "../../vendor-sdk-types/ai-sdk-v7-telemetry";
import { currentWorkflowAgentWrapperSpan } from "./workflow-agent-context";
import {
  currentHarnessTurnParent,
  startHarnessTurnChildSpan,
} from "./harness-agent-context";

type OperationState = {
  callId: string;
  firstChunkTime?: number;
  hadModelChild: boolean;
  harnessTurnParent?: Span | string;
  loggedInput: boolean;
  operationName: string;
  operationKey: string;
  ownsSpan: boolean;
  span: Span;
  startTime: number;
};

type CallSpanState = {
  operationKey: string;
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
  const operationKeysByCallId = new Map<string, string[]>();
  const workflowOperationKeyStore = iso.newAsyncLocalStorage<
    string | undefined
  >();
  const modelSpans = new Map<string, Span[]>();
  const objectSpans = new Map<string, Span>();
  const embedSpans = new Map<string, EmbedSpanState>();
  const rerankSpans = new Map<string, Span>();
  const toolSpans = new Map<string, CallSpanState>();
  let workflowAgentOperationCounter = 0;

  const runSafely = (name: string, callback: () => void) => {
    try {
      callback();
    } catch (error) {
      // eslint-disable-next-line no-restricted-properties
      console.error(`Error in Braintrust AI SDK telemetry ${name}:`, error);
    }
  };

  const startChildSpan = (
    operationKey: string,
    name: string,
    type: SpanTypeAttribute,
    event?: { input?: unknown; metadata?: Record<string, unknown> },
    parentOverride?: Span | string,
  ) => {
    const parent = operations.get(operationKey)?.span;
    const spanArgs = withSpanInstrumentationName(
      {
        name,
        spanAttributes: { type },
        ...(event ? { event } : {}),
      },
      INSTRUMENTATION_NAMES.AI_SDK,
    );
    const span = parentOverride
      ? startHarnessTurnChildSpan(parentOverride, spanArgs)
      : parent
        ? parent.startSpan(spanArgs)
        : startSpan(spanArgs);
    const state = operations.get(operationKey);
    if (state && type === SpanTypeAttribute.LLM) {
      state.hadModelChild = true;
    }
    return span;
  };

  const registerOperation = (state: OperationState): void => {
    operations.set(state.operationKey, state);
    const keys = operationKeysByCallId.get(state.callId) ?? [];
    keys.push(state.operationKey);
    operationKeysByCallId.set(state.callId, keys);
  };

  const deleteOperation = (operationKey: string): void => {
    const state = operations.get(operationKey);
    if (!state) {
      return;
    }

    operations.delete(operationKey);
    if (workflowOperationKeyStore.getStore() === operationKey) {
      // TODO(luca): Replace ALS.enterWith() with ALS.run() once direct
      // telemetry can wrap the full WorkflowAgent callback lifecycle.
      // eslint-disable-next-line no-restricted-syntax -- Existing ALS.enterWith() usage tracked by the TODO above.
      workflowOperationKeyStore.enterWith(undefined);
    }

    const keys = operationKeysByCallId.get(state.callId);
    if (!keys) {
      return;
    }

    const index = keys.indexOf(operationKey);
    if (index >= 0) {
      keys.splice(index, 1);
    }
    if (keys.length === 0) {
      operationKeysByCallId.delete(state.callId);
    }
  };

  const explicitOperationKey = (event: unknown): string | undefined => {
    if (!isObject(event)) {
      return undefined;
    }

    const key = (event as { [AI_SDK_V7_OPERATION_KEY]?: unknown })[
      AI_SDK_V7_OPERATION_KEY
    ];
    return typeof key === "string" ? key : undefined;
  };

  const createOperationKey = (
    event: AISDKV7OperationEvent,
    operationName: string,
  ): string => {
    const explicit = explicitOperationKey(event);
    if (explicit) {
      return explicit;
    }

    if (operationName === "WorkflowAgent.stream") {
      workflowAgentOperationCounter += 1;
      return `${event.callId}:${workflowAgentOperationCounter}`;
    }

    return event.callId;
  };

  const operationKeyForCallId = (
    callId: string,
    mode: "active" | "finish" = "active",
  ): string | undefined => {
    const keys = operationKeysByCallId.get(callId);
    if (!keys || keys.length === 0) {
      return operations.has(callId) ? callId : undefined;
    }

    if (keys.length === 1) {
      return keys[0];
    }

    const wrapperSpan = currentWorkflowAgentWrapperSpan();
    if (wrapperSpan?.spanId) {
      const key = keys.find(
        (candidate) =>
          operations.get(candidate)?.span.spanId === wrapperSpan.spanId,
      );
      if (key) {
        return key;
      }
    }

    const workflowOperationKey = workflowOperationKeyStore.getStore();
    if (workflowOperationKey && keys.includes(workflowOperationKey)) {
      return workflowOperationKey;
    }

    if (callId === "workflow-agent") {
      return undefined;
    }

    return mode === "finish" ? keys[0] : keys[keys.length - 1];
  };

  const operationKeyFromEvent = (
    event: { callId?: unknown } | unknown,
    mode: "active" | "finish" = "active",
  ): string | undefined => {
    const explicit = explicitOperationKey(event);
    if (explicit && operations.has(explicit)) {
      return explicit;
    }

    if (isObject(event)) {
      const callId = (event as { callId?: unknown }).callId;
      if (typeof callId === "string") {
        const operationKey = operationKeyForCallId(callId, mode);
        if (operationKey) {
          return operationKey;
        }

        const workflowOperationKey = workflowOperationKeyStore.getStore();
        if (workflowOperationKey && operations.has(workflowOperationKey)) {
          return workflowOperationKey;
        }

        return callId === "workflow-agent" ? undefined : callId;
      }
    }

    const workflowOperationKey = workflowOperationKeyStore.getStore();
    if (workflowOperationKey && operations.has(workflowOperationKey)) {
      return workflowOperationKey;
    }

    const wrapperSpan = currentWorkflowAgentWrapperSpan();
    if (wrapperSpan?.spanId) {
      for (const [operationKey, state] of operations) {
        if (
          state.operationName === "WorkflowAgent.stream" &&
          state.span.spanId === wrapperSpan.spanId
        ) {
          return operationKey;
        }
      }
    }

    // WorkflowAgent uses this callId on the operation, but omits it from
    // tool start/end callbacks in @ai-sdk/workflow@1.0.x.
    const workflowAgentKeys = operationKeysByCallId.get("workflow-agent");
    if (workflowAgentKeys?.length === 1) {
      return workflowAgentKeys[0];
    }

    if (operations.size === 1) {
      return operations.keys().next().value;
    }

    return undefined;
  };

  const closeOpenChildSpans = (operationKey: string, error?: unknown): void => {
    const openModelSpans = modelSpans.get(operationKey);
    if (openModelSpans) {
      for (const span of openModelSpans) {
        if (error !== undefined) {
          logError(span, error);
        }
        span.end();
      }
      modelSpans.delete(operationKey);
    }

    const openObjectSpan = objectSpans.get(operationKey);
    if (openObjectSpan) {
      if (error !== undefined) {
        logError(openObjectSpan, error);
      }
      openObjectSpan.end();
      objectSpans.delete(operationKey);
    }

    for (const [embedCallId, embedState] of embedSpans) {
      if (embedState.operationKey === operationKey) {
        if (error !== undefined) {
          logError(embedState.span, error);
        }
        embedState.span.end();
        embedSpans.delete(embedCallId);
      }
    }

    const openRerankSpan = rerankSpans.get(operationKey);
    if (openRerankSpan) {
      if (error !== undefined) {
        logError(openRerankSpan, error);
      }
      openRerankSpan.end();
      rerankSpans.delete(operationKey);
    }

    for (const [toolCallId, toolState] of toolSpans) {
      if (toolState.operationKey === operationKey) {
        if (error !== undefined) {
          logError(toolState.span, error);
        }
        toolState.span.end();
        toolSpans.delete(toolCallId);
      }
    }
  };

  const abortReasonFromEvent = (event: unknown): unknown => {
    if (isObject(event)) {
      const abortEvent = event as { error?: unknown; reason?: unknown };
      if (abortEvent.error !== undefined) {
        return abortEvent.error;
      }
      if (abortEvent.reason !== undefined) {
        return abortEvent.reason;
      }
    }

    return new Error("AI SDK operation aborted");
  };

  const shouldSkipTelemetryChildren = (state?: OperationState): boolean =>
    state?.operationName === "WorkflowAgent.stream" && !state.ownsSpan;

  const onObjectStepEnd = (
    event: Parameters<NonNullable<AISDKV7Telemetry["onObjectStepEnd"]>>[0],
  ) => {
    runSafely("onObjectStepEnd", () => {
      const operationKey = operationKeyFromEvent(event);
      const span = operationKey ? objectSpans.get(operationKey) : undefined;
      if (!operationKey || !span) {
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
      objectSpans.delete(operationKey);
    });
  };

  const onEmbedEnd = (
    event: Parameters<NonNullable<AISDKV7Telemetry["onEmbedEnd"]>>[0],
  ) => {
    runSafely("onEmbedEnd", () => {
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
  };

  const onRerankEnd = (
    event: Parameters<NonNullable<AISDKV7Telemetry["onRerankEnd"]>>[0],
  ) => {
    runSafely("onRerankEnd", () => {
      const operationKey = operationKeyFromEvent(event);
      const span = operationKey ? rerankSpans.get(operationKey) : undefined;
      if (!operationKey || !span) {
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
      rerankSpans.delete(operationKey);
    });
  };

  const onEnd = (
    event: Parameters<NonNullable<AISDKV7Telemetry["onEnd"]>>[0],
  ) => {
    runSafely("onEnd", () => {
      const operationKey = operationKeyFromEvent(event, "finish");
      const state = operationKey ? operations.get(operationKey) : undefined;
      if (!state) {
        return;
      }
      if (!state.ownsSpan) {
        deleteOperation(state.operationKey);
        return;
      }

      const result = finishResult(event, state.operationName);
      const metrics: Record<string, number> = state.hadModelChild
        ? {}
        : extractTokenMetrics(result);
      const timeToFirstToken =
        state.operationName === "WorkflowAgent.stream"
          ? undefined
          : extractTimeToFirstToken(result, state);
      if (timeToFirstToken !== undefined) {
        metrics.time_to_first_token = timeToFirstToken;
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
      deleteOperation(state.operationKey);
    });
  };

  return {
    onStart(event) {
      runSafely("onStart", () => {
        const operationName = operationNameFromId(event.operationId);
        const workflowAgent = operationName === "WorkflowAgent.stream";
        const wrapperSpan = workflowAgent
          ? currentWorkflowAgentWrapperSpan()
          : undefined;
        const ownsSpan = !wrapperSpan;
        const harnessTurnParent = currentHarnessTurnParent();
        const span = ownsSpan
          ? harnessTurnParent
            ? startHarnessTurnChildSpan(
                harnessTurnParent,
                withSpanInstrumentationName(
                  {
                    name: operationName,
                    spanAttributes: { type: SpanTypeAttribute.FUNCTION },
                  },
                  INSTRUMENTATION_NAMES.AI_SDK,
                ),
              )
            : startSpan(
                withSpanInstrumentationName(
                  {
                    name: operationName,
                    spanAttributes: { type: SpanTypeAttribute.FUNCTION },
                  },
                  INSTRUMENTATION_NAMES.AI_SDK,
                ),
              )
          : wrapperSpan;
        const operationKey = createOperationKey(event, operationName);

        registerOperation({
          callId: event.callId,
          hadModelChild: false,
          harnessTurnParent,
          loggedInput: false,
          operationName,
          operationKey,
          ownsSpan,
          span,
          startTime: getCurrentUnixTimestamp(),
        });

        if (!ownsSpan) {
          return;
        }

        if (workflowAgent) {
          // Direct registerTelemetry() calls do not receive the hidden
          // dispatcher operation key used by auto-instrumentation.
          // TODO(luca): Replace ALS.enterWith() with ALS.run() once direct
          // telemetry can wrap the full WorkflowAgent callback lifecycle.
          // eslint-disable-next-line no-restricted-syntax -- Existing ALS.enterWith() usage tracked by the TODO above.
          workflowOperationKeyStore.enterWith(operationKey);
        }

        let metadata = metadataFromEvent(event);
        const logPayload: {
          input?: unknown;
          metadata: Record<string, unknown>;
        } = { metadata };

        const workflowAgentCallInput = workflowAgent
          ? operationInput(event, operationName)
          : undefined;
        if (workflowAgentCallInput) {
          metadata = {
            ...metadata,
            ...extractWorkflowMetadataFromCallParams(workflowAgentCallInput),
          };
          logPayload.metadata = metadata;
        }

        if (shouldRecordInputs(event)) {
          const callInput =
            workflowAgentCallInput ?? operationInput(event, operationName);
          const { input, outputPromise } = workflowAgent
            ? processAISDKWorkflowAgentCallInput(callInput)
            : processAISDKCallInput(callInput);
          logPayload.input = input;
          const state = operations.get(operationKey);
          if (state) {
            state.loggedInput = hasPromptLikeInput(input);
          }
          if (
            outputPromise &&
            !workflowAgent &&
            input &&
            typeof input === "object"
          ) {
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
        const operationKey = operationKeyFromEvent(event);
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (shouldSkipTelemetryChildren(state)) {
          return;
        }
        const operationName = state?.operationName ?? "generateText";
        const callInput = operationInput(event, operationName);
        const workflowAgent = operationName === "WorkflowAgent.stream";
        const processedInput =
          shouldRecordInputs(event) && workflowAgent
            ? processAISDKWorkflowAgentModelCallInput(callInput).input
            : shouldRecordInputs(event)
              ? processAISDKCallInput(callInput).input
              : undefined;
        if (
          workflowAgent &&
          state?.ownsSpan &&
          !state.loggedInput &&
          hasPromptLikeInput(processedInput)
        ) {
          state.span.log({
            input: processedInput,
            metadata: {
              ...metadataFromEvent(event),
              ...extractWorkflowMetadataFromCallParams(callInput),
            },
          });
          state.loggedInput = true;
        }
        const openSpans = operationKey
          ? modelSpans.get(operationKey)
          : undefined;
        if (operationKey && openSpans) {
          for (const span of openSpans) {
            span.end();
          }
          modelSpans.delete(operationKey);
        }

        const span = startChildSpan(
          operationKey ?? event.callId,
          operationName === "streamText" ? "doStream" : "doGenerate",
          SpanTypeAttribute.LLM,
          {
            ...(shouldRecordInputs(event)
              ? {
                  input: processedInput,
                }
              : {}),
            metadata: workflowAgent
              ? {
                  ...metadataFromEvent(event),
                  ...extractWorkflowMetadataFromCallParams(callInput),
                }
              : metadataFromEvent(event),
          },
        );
        const spanKey = operationKey ?? event.callId;
        const spans = modelSpans.get(spanKey) ?? [];
        spans.push(span);
        modelSpans.set(spanKey, spans);
      });
    },

    onLanguageModelCallEnd(event) {
      runSafely("onLanguageModelCallEnd", () => {
        const operationKey = operationKeyFromEvent(event);
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (shouldSkipTelemetryChildren(state)) {
          return;
        }
        const span = operationKey
          ? shiftModelSpan(modelSpans, operationKey)
          : undefined;
        if (!span) {
          return;
        }

        const timeToFirstOutputMs = safePerformance(event)?.timeToFirstOutputMs;
        if (
          state?.operationName === "streamText" &&
          state.firstChunkTime === undefined &&
          typeof timeToFirstOutputMs === "number"
        ) {
          state.firstChunkTime = state.startTime + timeToFirstOutputMs / 1000;
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
        const operationKey = operationKeyFromEvent(event);
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (shouldSkipTelemetryChildren(state)) {
          return;
        }
        const openSpan = operationKey
          ? objectSpans.get(operationKey)
          : undefined;
        if (operationKey && openSpan) {
          openSpan.end();
          objectSpans.delete(operationKey);
        }

        const span = startChildSpan(
          operationKey ?? event.callId,
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
        objectSpans.set(operationKey ?? event.callId, span);
      });
    },

    onObjectStepEnd,

    onEmbedStart(event) {
      runSafely("onEmbedStart", () => {
        const operationKey = operationKeyFromEvent(event);
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (shouldSkipTelemetryChildren(state)) {
          return;
        }
        for (const [embedCallId, embedState] of embedSpans) {
          if (
            embedState.operationKey === operationKey &&
            (state?.operationName === "embed" ||
              embedState.values === event.values)
          ) {
            embedState.span.end();
            embedSpans.delete(embedCallId);
          }
        }

        const span = startChildSpan(
          operationKey ?? event.callId,
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
          operationKey: operationKey ?? event.callId,
          span,
          values: event.values,
        });
      });
    },

    onEmbedEnd,

    onRerankStart(event) {
      runSafely("onRerankStart", () => {
        const operationKey = operationKeyFromEvent(event);
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (shouldSkipTelemetryChildren(state)) {
          return;
        }
        const openSpan = operationKey
          ? rerankSpans.get(operationKey)
          : undefined;
        if (operationKey && openSpan) {
          openSpan.end();
          rerankSpans.delete(operationKey);
        }

        const span = startChildSpan(
          operationKey ?? event.callId,
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
        rerankSpans.set(operationKey ?? event.callId, span);
      });
    },

    onRerankEnd,

    onToolExecutionStart(event) {
      runSafely("onToolExecutionStart", () => {
        const operationKey = operationKeyFromEvent(event);
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (shouldSkipTelemetryChildren(state)) {
          return;
        }
        const toolCallId = event.toolCall.toolCallId;
        if (!operationKey || !toolCallId) {
          return;
        }

        const span = startChildSpan(
          operationKey,
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
          state?.harnessTurnParent,
        );
        toolSpans.set(toolCallId, { operationKey, span });
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
        const workflowToolError =
          (event as { success?: unknown }).success === false && "error" in event
            ? (event as { error?: unknown }).error
            : undefined;

        if (
          toolOutput?.type === "tool-error" ||
          workflowToolError !== undefined
        ) {
          const error = toolOutput?.error ?? workflowToolError;
          state.span.log({
            error: error instanceof Error ? error.message : String(error),
            metrics:
              typeof event.durationMs === "number"
                ? { duration_ms: event.durationMs }
                : {},
          });
        } else {
          const output =
            toolOutput && "output" in toolOutput
              ? toolOutput.output
              : (event as { output?: unknown }).output;
          state.span.log({
            ...(shouldRecordOutputs(event) ? { output } : {}),
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
        const operationKey = operationKeyForCallId(callId);
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (!state || state.firstChunkTime !== undefined) {
          return;
        }
        state.firstChunkTime = getCurrentUnixTimestamp();
      });
    },

    onEnd,

    onAbort(event) {
      runSafely("onAbort", () => {
        const operationKey = operationKeyFromEvent(event, "finish");
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (!operationKey || !state) {
          return;
        }

        const error = abortReasonFromEvent(event);
        closeOpenChildSpans(operationKey, error);
        if (state.ownsSpan) {
          logError(state.span, error);
          state.span.end();
        }
        deleteOperation(operationKey);
      });
    },

    onError(event) {
      runSafely("onError", () => {
        const errorEvent = isObject(event)
          ? (event as { callId?: unknown; error?: unknown })
          : {};
        const operationKey = operationKeyFromEvent(errorEvent, "finish");
        const state = operationKey ? operations.get(operationKey) : undefined;
        if (!operationKey || !state) {
          return;
        }
        const error = errorEvent.error ?? event;

        closeOpenChildSpans(operationKey, error);
        if (state.ownsSpan) {
          logError(state.span, error);
          state.span.end();
        }
        deleteOperation(operationKey);
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

function hasPromptLikeInput(input: unknown): boolean {
  if (!isObject(input)) {
    return false;
  }

  return input.prompt !== undefined || input.messages !== undefined;
}

function operationNameFromId(operationId: string | undefined): string {
  if (operationId === "ai.workflowAgent.stream") {
    return "WorkflowAgent.stream";
  }

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
    instructions: event.instructions,
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

function extractTimeToFirstToken(
  result: AISDKResult | AISDKEmbeddingResult | AISDKRerankResult,
  state: OperationState,
): number | undefined {
  if (state.firstChunkTime !== undefined) {
    return state.firstChunkTime - state.startTime;
  }

  const performanceCandidates = [
    safePerformance(result),
    safePerformance((result as { finalStep?: unknown }).finalStep),
    ...(Array.isArray((result as { steps?: unknown }).steps)
      ? ((result as { steps: unknown[] }).steps ?? []).map(safePerformance)
      : []),
  ];

  for (const performance of performanceCandidates) {
    const timeToFirstOutputMs = performance?.timeToFirstOutputMs;
    if (typeof timeToFirstOutputMs === "number") {
      return timeToFirstOutputMs / 1000;
    }
  }

  return undefined;
}

function safePerformance(
  value: unknown,
): { timeToFirstOutputMs?: unknown } | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const performance = (value as { performance?: unknown }).performance;
  return isObject(performance)
    ? (performance as { timeToFirstOutputMs?: unknown })
    : undefined;
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
