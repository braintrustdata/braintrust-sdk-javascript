import { BasePlugin } from "../core";
import {
  traceAsyncChannel,
  traceStreamingChannel,
  traceSyncStreamChannel,
  unsubscribeAll,
} from "../core/channel-tracing";
import type { ChannelMessage } from "../core/channel-definitions";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { withCurrent } from "../../logger";
import type { Span } from "../../logger";
import { getCurrentUnixTimestamp } from "../../util";
import { zodToJsonSchema } from "../../zod/utils";
import { openRouterChannels } from "./openrouter-channels";
import type {
  OpenRouterChatChoice,
  OpenRouterChatCompletionChunk,
  OpenRouterCallModelRequest,
  OpenRouterEmbeddingResponse,
  OpenRouterResponse,
  OpenRouterResponseStreamEvent,
  OpenRouterTool,
  OpenRouterToolTurnContext,
} from "../../vendor-sdk-types/openrouter";

export class OpenRouterPlugin extends BasePlugin {
  protected onEnable(): void {
    this.subscribeToOpenRouterChannels();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToOpenRouterChannels(): void {
    this.unsubscribers.push(
      traceStreamingChannel(openRouterChannels.chatSend, {
        name: "openrouter.chat.send",
        type: SpanTypeAttribute.LLM,
        extractInput: (args) => {
          const request = getOpenRouterRequestArg(args);
          const chatGenerationParams = isObject(request?.chatGenerationParams)
            ? request.chatGenerationParams
            : {};
          const httpReferer = request?.httpReferer;
          const xTitle = request?.xTitle;
          const { messages, ...metadata } = chatGenerationParams;
          return {
            input: messages,
            metadata: buildOpenRouterMetadata(metadata, httpReferer, xTitle),
          };
        },
        extractOutput: (result) => {
          return isObject(result) ? result.choices : undefined;
        },
        extractMetrics: (result, startTime) => {
          const metrics = parseOpenRouterMetricsFromUsage(result?.usage);
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateOpenRouterChatChunks,
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(openRouterChannels.embeddingsGenerate, {
        name: "openrouter.embeddings.generate",
        type: SpanTypeAttribute.LLM,
        extractInput: (args) => {
          const request = getOpenRouterRequestArg(args);
          const requestBody = isObject(request?.requestBody)
            ? request.requestBody
            : {};
          const httpReferer = request?.httpReferer;
          const xTitle = request?.xTitle;
          const { input, ...metadata } = requestBody;
          return {
            input,
            metadata: buildOpenRouterEmbeddingMetadata(
              metadata,
              httpReferer,
              xTitle,
            ),
          };
        },
        extractOutput: (result) => {
          if (!isObject(result)) {
            return undefined;
          }

          const embedding = result.data?.[0]?.embedding;
          return Array.isArray(embedding)
            ? { embedding_length: embedding.length }
            : undefined;
        },
        extractMetadata: (result) => {
          if (!isObject(result)) {
            return undefined;
          }

          return extractOpenRouterResponseMetadata(result);
        },
        extractMetrics: (result) => {
          return isObject(result)
            ? parseOpenRouterMetricsFromUsage(result.usage)
            : {};
        },
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(openRouterChannels.betaResponsesSend, {
        name: "openrouter.beta.responses.send",
        type: SpanTypeAttribute.LLM,
        extractInput: (args) => {
          const request = getOpenRouterRequestArg(args);
          const openResponsesRequest = isObject(request?.openResponsesRequest)
            ? request.openResponsesRequest
            : {};
          const httpReferer = request?.httpReferer;
          const xTitle = request?.xTitle;
          const { input, ...metadata } = openResponsesRequest;
          return {
            input,
            metadata: buildOpenRouterMetadata(metadata, httpReferer, xTitle),
          };
        },
        extractOutput: (result) =>
          extractOpenRouterResponseOutput(result as Record<string, unknown>),
        extractMetadata: (result) => extractOpenRouterResponseMetadata(result),
        extractMetrics: (result, startTime) => {
          const metrics = parseOpenRouterMetricsFromUsage(result?.usage);
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateOpenRouterResponseStreamEvents,
      }),
    );

    this.unsubscribers.push(
      traceSyncStreamChannel(openRouterChannels.callModel, {
        name: "openrouter.callModel",
        type: SpanTypeAttribute.LLM,
        extractInput: (args) => {
          const request = getOpenRouterCallModelRequestArg(args);
          return {
            input: request
              ? extractOpenRouterCallModelInput(request)
              : undefined,
            metadata: request
              ? extractOpenRouterCallModelMetadata(request)
              : { provider: "openrouter" },
          };
        },
        patchResult: ({ endEvent, result, span }) => {
          return patchOpenRouterCallModelResult({
            request: getOpenRouterCallModelRequestArg(endEvent.arguments),
            result,
            span,
          });
        },
      }),
    );

    this.unsubscribers.push(
      traceAsyncChannel(openRouterChannels.callModelTurn, {
        name: "openrouter.beta.responses.send",
        type: SpanTypeAttribute.LLM,
        extractInput: (args, event) => {
          const request = getOpenRouterCallModelRequestArg(args);
          const metadata = request
            ? extractOpenRouterCallModelMetadata(request)
            : { provider: "openrouter" };

          if (isObject(metadata) && "tools" in metadata) {
            delete (metadata as Record<string, unknown>).tools;
          }

          return {
            input: request
              ? extractOpenRouterCallModelInput(request)
              : undefined,
            metadata: {
              ...metadata,
              step: event.step,
              step_type: event.stepType,
            },
          };
        },
        extractOutput: (result) =>
          extractOpenRouterResponseOutput(result as Record<string, unknown>),
        extractMetadata: (result, event) => {
          if (!isObject(result)) {
            return {
              step: event?.step,
              step_type: event?.stepType,
            };
          }

          return {
            ...(extractOpenRouterResponseMetadata(result) || {}),
            ...(event?.step !== undefined ? { step: event.step } : {}),
            ...(event?.stepType ? { step_type: event.stepType } : {}),
          };
        },
        extractMetrics: (result) =>
          isObject(result) ? parseOpenRouterMetricsFromUsage(result.usage) : {},
      }),
    );

    this.unsubscribers.push(
      traceStreamingChannel(openRouterChannels.toolExecute, {
        name: "openrouter.tool",
        type: SpanTypeAttribute.TOOL,
        extractInput: (args, event) => ({
          input: args[0],
          metadata: {
            provider: "openrouter",
            tool_name: event.toolName,
            ...(event.toolCallId ? { tool_call_id: event.toolCallId } : {}),
          },
        }),
        extractOutput: (result) => result,
        extractMetrics: () => ({}),
        aggregateChunks: (chunks) => ({
          output: chunks.length > 0 ? chunks[chunks.length - 1] : undefined,
          metrics: {},
        }),
      }),
    );

    const callModelChannel = openRouterChannels.callModel.tracingChannel();
    const callModelHandlers = {
      start: (event: { arguments: unknown[] }) => {
        const request = getOpenRouterCallModelRequestArg(event.arguments);
        if (!request) {
          return;
        }

        patchOpenRouterCallModelRequestTools(request);
      },
    };

    callModelChannel.subscribe(callModelHandlers);
    this.unsubscribers.push(() => {
      callModelChannel.unsubscribe(callModelHandlers);
    });
  }
}

function normalizeArgs(args: unknown[] | unknown): unknown[] {
  if (Array.isArray(args)) {
    return args;
  }

  if (isArrayLike(args)) {
    return Array.from(args);
  }

  return [args];
}

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return (
    isObject(value) &&
    "length" in value &&
    typeof value.length === "number" &&
    Number.isInteger(value.length) &&
    value.length >= 0
  );
}

function getOpenRouterRequestArg(
  args: unknown[] | unknown,
): Record<string, unknown> | undefined {
  const normalizedArgs = normalizeArgs(args);
  const keyedCandidate = normalizedArgs.find(
    (arg) =>
      isObject(arg) &&
      ("chatGenerationParams" in arg ||
        "requestBody" in arg ||
        "openResponsesRequest" in arg),
  );

  if (isObject(keyedCandidate)) {
    return keyedCandidate;
  }

  const firstObjectArg = normalizedArgs.find((arg) => isObject(arg));
  return isObject(firstObjectArg) ? firstObjectArg : undefined;
}

function getOpenRouterCallModelRequestArg(
  args: unknown[] | unknown,
): OpenRouterCallModelRequest | undefined {
  const firstObjectArg = normalizeArgs(args).find((arg) => isObject(arg));
  return isObject(firstObjectArg)
    ? (firstObjectArg as OpenRouterCallModelRequest)
    : undefined;
}

const TOKEN_NAME_MAP: Record<string, string> = {
  promptTokens: "prompt_tokens",
  inputTokens: "prompt_tokens",
  completionTokens: "completion_tokens",
  outputTokens: "completion_tokens",
  totalTokens: "tokens",
  prompt_tokens: "prompt_tokens",
  input_tokens: "prompt_tokens",
  completion_tokens: "completion_tokens",
  output_tokens: "completion_tokens",
  total_tokens: "tokens",
};

const TOKEN_DETAIL_PREFIX_MAP: Record<string, string> = {
  promptTokensDetails: "prompt",
  inputTokensDetails: "prompt",
  completionTokensDetails: "completion",
  outputTokensDetails: "completion",
  costDetails: "cost",
  prompt_tokens_details: "prompt",
  input_tokens_details: "prompt",
  completion_tokens_details: "completion",
  output_tokens_details: "completion",
  cost_details: "cost",
};

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function parseOpenRouterMetricsFromUsage(
  usage: unknown,
): Record<string, number> {
  if (!isObject(usage)) {
    return {};
  }

  const metrics: Record<string, number> = {};

  for (const [name, value] of Object.entries(usage)) {
    if (typeof value === "number") {
      metrics[TOKEN_NAME_MAP[name] || camelToSnake(name)] = value;
      continue;
    }

    if (!isObject(value)) {
      continue;
    }

    const prefix = TOKEN_DETAIL_PREFIX_MAP[name];
    if (!prefix) {
      continue;
    }

    for (const [nestedName, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue !== "number") {
        continue;
      }

      metrics[`${prefix}_${camelToSnake(nestedName)}`] = nestedValue;
    }
  }

  return metrics;
}

function extractOpenRouterUsageMetadata(
  usage: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(usage)) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};

  if (typeof usage.isByok === "boolean") {
    metadata.is_byok = usage.isByok;
  } else if (typeof usage.is_byok === "boolean") {
    metadata.is_byok = usage.is_byok;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

const OMITTED_OPENROUTER_KEYS = new Set([
  "execute",
  "render",
  "nextTurnParams",
  "requireApproval",
]);

function parseOpenRouterModelString(model: unknown): {
  model: unknown;
  provider?: string;
} {
  if (typeof model !== "string") {
    return { model };
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex > 0 && slashIndex < model.length - 1) {
    return {
      provider: model.substring(0, slashIndex),
      model: model.substring(slashIndex + 1),
    };
  }

  return { model };
}

function isZodSchema(value: unknown): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    "_def" in value &&
    typeof (value as { _def?: unknown })._def === "object"
  );
}

function serializeZodSchema(schema: unknown): Record<string, unknown> {
  try {
    return zodToJsonSchema(schema as any) as Record<string, unknown>;
  } catch {
    return {
      type: "object",
      description: "Zod schema (conversion failed)",
    };
  }
}

function serializeOpenRouterTool(tool: OpenRouterTool): OpenRouterTool {
  if (!isObject(tool)) {
    return tool;
  }

  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tool)) {
    if (OMITTED_OPENROUTER_KEYS.has(key)) {
      continue;
    }

    if (key === "function" && isObject(value)) {
      serialized.function = sanitizeOpenRouterLoggedValue(value);
      continue;
    }

    serialized[key] = sanitizeOpenRouterLoggedValue(value);
  }

  return serialized as OpenRouterTool;
}

function serializeOpenRouterToolsForLogging(
  tools: readonly OpenRouterTool[] | undefined,
): OpenRouterTool[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  return tools.map((tool) => serializeOpenRouterTool(tool));
}

function sanitizeOpenRouterLoggedValue(value: unknown): unknown {
  if (isZodSchema(value)) {
    return serializeZodSchema(value);
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOpenRouterLoggedValue(entry));
  }

  if (!isObject(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (OMITTED_OPENROUTER_KEYS.has(key)) {
      continue;
    }

    if (key === "tools" && Array.isArray(entry)) {
      sanitized.tools = serializeOpenRouterToolsForLogging(entry);
      continue;
    }

    sanitized[key] = sanitizeOpenRouterLoggedValue(entry);
  }

  return sanitized;
}

function buildOpenRouterMetadata(
  metadata: Record<string, unknown>,
  httpReferer: unknown,
  xTitle: unknown,
): Record<string, unknown> {
  const sanitized = sanitizeOpenRouterLoggedValue(metadata);
  const metadataRecord = isObject(sanitized) ? sanitized : {};
  const { model, provider: providerRouting, ...rest } = metadataRecord;
  const normalizedModel = parseOpenRouterModelString(model);

  return {
    ...rest,
    ...(normalizedModel.model !== undefined
      ? { model: normalizedModel.model }
      : {}),
    ...(providerRouting !== undefined ? { providerRouting } : {}),
    ...(httpReferer !== undefined ? { httpReferer } : {}),
    ...(xTitle !== undefined ? { xTitle } : {}),
    provider: normalizedModel.provider || "openrouter",
  };
}

function buildOpenRouterEmbeddingMetadata(
  metadata: Record<string, unknown>,
  httpReferer: unknown,
  xTitle: unknown,
): Record<string, unknown> {
  const normalized = buildOpenRouterMetadata(metadata, httpReferer, xTitle);
  return typeof normalized.model === "string"
    ? {
        ...normalized,
        embedding_model: normalized.model,
      }
    : normalized;
}

function extractOpenRouterCallModelInput(
  request: OpenRouterCallModelRequest,
): unknown {
  return isObject(request) && "input" in request
    ? sanitizeOpenRouterLoggedValue(request.input)
    : undefined;
}

function extractOpenRouterCallModelMetadata(
  request: OpenRouterCallModelRequest,
): Record<string, unknown> {
  if (!isObject(request)) {
    return { provider: "openrouter" };
  }

  const { input: _input, ...metadata } = request;
  return buildOpenRouterMetadata(metadata, undefined, undefined);
}

function extractOpenRouterResponseMetadata(
  result: OpenRouterResponse | OpenRouterEmbeddingResponse | undefined,
): Record<string, unknown> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  const { output: _output, data: _data, usage, ...metadata } = result;
  const sanitized = sanitizeOpenRouterLoggedValue(metadata);
  const metadataRecord = isObject(sanitized) ? sanitized : {};
  const { model, provider, ...rest } = metadataRecord;
  const normalizedModel = parseOpenRouterModelString(model);
  const normalizedProvider =
    (typeof provider === "string" ? provider : undefined) ||
    normalizedModel.provider;
  const usageMetadata = extractOpenRouterUsageMetadata(usage);
  const combined = {
    ...rest,
    ...(normalizedModel.model !== undefined
      ? { model: normalizedModel.model }
      : {}),
    ...(usageMetadata || {}),
    ...(normalizedProvider !== undefined
      ? { provider: normalizedProvider }
      : {}),
  };

  return Object.keys(combined).length > 0 ? combined : undefined;
}

function extractOpenRouterResponseOutput(
  response: Record<string, unknown> | undefined,
  fallbackOutput?: unknown,
): unknown {
  if (
    isObject(response) &&
    "output" in response &&
    response.output !== undefined
  ) {
    return sanitizeOpenRouterLoggedValue(response.output);
  }

  if (fallbackOutput !== undefined) {
    return sanitizeOpenRouterLoggedValue(fallbackOutput);
  }

  return undefined;
}

const OPENROUTER_WRAPPED_TOOL = Symbol("braintrust.openrouter.wrappedTool");

type OpenRouterToolTraceContext = ChannelMessage<
  typeof openRouterChannels.toolExecute
>;

type WrappedOpenRouterTool = OpenRouterTool & {
  [OPENROUTER_WRAPPED_TOOL]?: true;
};

function patchOpenRouterCallModelRequestTools(
  request: OpenRouterCallModelRequest,
): (() => void) | undefined {
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    return undefined;
  }

  const originalTools = request.tools;
  const wrappedTools = originalTools.map((tool) => wrapOpenRouterTool(tool));
  const didPatch = wrappedTools.some(
    (tool, index) => tool !== originalTools[index],
  );
  if (!didPatch) {
    return undefined;
  }

  (request as { tools?: readonly OpenRouterTool[] }).tools = wrappedTools;
  return () => {
    (request as { tools?: readonly OpenRouterTool[] }).tools = originalTools;
  };
}

function wrapOpenRouterTool(tool: OpenRouterTool): OpenRouterTool {
  if (
    isWrappedTool(tool) ||
    !tool.function ||
    typeof tool.function !== "object" ||
    typeof tool.function.execute !== "function"
  ) {
    return tool;
  }

  const toolName = tool.function.name || "tool";
  const originalExecute = tool.function.execute;
  const wrappedTool: WrappedOpenRouterTool = {
    ...tool,
    function: {
      ...tool.function,
      execute(this: unknown, ...args: unknown[]) {
        return traceToolExecution({
          args,
          execute: () => Reflect.apply(originalExecute, this, args),
          toolCallId: getToolCallId(args[1]),
          toolName,
        });
      },
    },
  };

  Object.defineProperty(wrappedTool, OPENROUTER_WRAPPED_TOOL, {
    value: true,
    enumerable: false,
    configurable: false,
  });

  return wrappedTool;
}

function isWrappedTool(tool: OpenRouterTool): boolean {
  return Boolean((tool as WrappedOpenRouterTool)[OPENROUTER_WRAPPED_TOOL]);
}

function traceToolExecution(args: {
  args: unknown[];
  execute: () => unknown;
  toolCallId?: string;
  toolName: string;
}): unknown {
  const tracingChannel = openRouterChannels.toolExecute.tracingChannel();
  const input = args.args.length > 0 ? args.args[0] : undefined;
  const event: OpenRouterToolTraceContext = {
    arguments: [input],
    span_info: {
      name: args.toolName,
    },
    toolCallId: args.toolCallId,
    toolName: args.toolName,
  };

  tracingChannel.start!.publish(event);

  try {
    const result = args.execute();
    return publishToolResult(tracingChannel, event, result);
  } catch (error) {
    event.error = normalizeError(error);
    tracingChannel.error!.publish(event);
    throw error;
  }
}

function publishToolResult(
  tracingChannel: ReturnType<
    typeof openRouterChannels.toolExecute.tracingChannel
  >,
  event: OpenRouterToolTraceContext,
  result: unknown,
): unknown {
  if (isPromiseLike(result)) {
    return result.then(
      (resolved) => {
        event.result = resolved;
        tracingChannel.asyncEnd!.publish(event);
        return resolved;
      },
      (error) => {
        event.error = normalizeError(error);
        tracingChannel.error!.publish(event);
        throw error;
      },
    );
  }

  event.result = result;
  tracingChannel.asyncEnd!.publish(event);
  return result;
}

function getToolCallId(context: unknown): string | undefined {
  const toolContext = context as OpenRouterToolTurnContext | undefined;
  return typeof toolContext?.toolCall?.id === "string"
    ? toolContext.toolCall.id
    : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function aggregateOpenRouterChatChunks(
  chunks: OpenRouterChatCompletionChunk[],
): {
  output: OpenRouterChatChoice[];
  metrics: Record<string, number>;
} {
  let role: string | undefined;
  let content = "";
  let toolCalls:
    | Array<{
        index?: number;
        id?: string;
        type?: string;
        function: {
          name?: string;
          arguments: string;
        };
      }>
    | undefined;
  let finishReason: string | null | undefined;
  let metrics: Record<string, number> = {};

  for (const chunk of chunks) {
    metrics = {
      ...metrics,
      ...parseOpenRouterMetricsFromUsage(chunk?.usage),
    };

    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    if (!delta) {
      if (choice?.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
      continue;
    }

    if (!role && delta.role) {
      role = delta.role;
    }

    if (typeof delta.content === "string") {
      content += delta.content;
    }

    const choiceFinishReason =
      choice?.finishReason ?? choice?.finish_reason ?? undefined;
    const deltaFinishReason =
      delta.finishReason ?? delta.finish_reason ?? undefined;

    if (choiceFinishReason !== undefined) {
      finishReason = choiceFinishReason;
    } else if (deltaFinishReason !== undefined) {
      finishReason = deltaFinishReason;
    }

    const toolCallDeltas = Array.isArray(delta.toolCalls)
      ? delta.toolCalls
      : Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : undefined;

    if (!toolCallDeltas) {
      continue;
    }

    for (const toolDelta of toolCallDeltas) {
      if (!toolDelta?.function) {
        continue;
      }

      const toolIndex = toolDelta.index ?? 0;
      const existingToolCall = toolCalls?.[toolIndex];

      if (
        !existingToolCall ||
        (toolDelta.id &&
          existingToolCall.id !== undefined &&
          existingToolCall.id !== toolDelta.id)
      ) {
        const nextToolCalls = [...(toolCalls || [])];
        nextToolCalls[toolIndex] = {
          index: toolIndex,
          id: toolDelta.id,
          type: toolDelta.type,
          function: {
            name: toolDelta.function.name,
            arguments: toolDelta.function.arguments || "",
          },
        };
        toolCalls = nextToolCalls;
        continue;
      }

      const current = existingToolCall;
      if (toolDelta.id && !current.id) {
        current.id = toolDelta.id;
      }
      if (toolDelta.type && !current.type) {
        current.type = toolDelta.type;
      }
      if (toolDelta.function.name && !current.function.name) {
        current.function.name = toolDelta.function.name;
      }
      current.function.arguments += toolDelta.function.arguments || "";
    }
  }

  return {
    output: [
      {
        index: 0,
        message: {
          role,
          content: content || undefined,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    metrics,
  };
}

export function aggregateOpenRouterResponseStreamEvents(
  chunks: OpenRouterResponseStreamEvent[],
): {
  output: unknown;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  let finalResponse: OpenRouterResponse | undefined;

  for (const chunk of chunks) {
    const response = chunk?.response;
    if (!response) {
      continue;
    }

    if (
      chunk.type === "response.completed" ||
      chunk.type === "response.incomplete" ||
      chunk.type === "response.failed"
    ) {
      finalResponse = response;
    }
  }

  if (!finalResponse) {
    return {
      output: undefined,
      metrics: {},
    };
  }

  return {
    output: extractOpenRouterResponseOutput(finalResponse),
    metrics: parseOpenRouterMetricsFromUsage(finalResponse.usage),
    ...(extractOpenRouterResponseMetadata(finalResponse)
      ? { metadata: extractOpenRouterResponseMetadata(finalResponse) }
      : {}),
  };
}

const OPENROUTER_WRAPPED_CALL_MODEL_RESULT = Symbol(
  "braintrust.openrouter.wrappedCallModelResult",
);

const OPENROUTER_CALL_MODEL_STREAM_METHODS = [
  "getFullResponsesStream",
  "getItemsStream",
  "getNewMessagesStream",
  "getReasoningStream",
  "getTextStream",
  "getToolCallsStream",
  "getToolStream",
] as const;

const OPENROUTER_CALL_MODEL_CONTEXT_METHODS = [
  "cancel",
  "getPendingToolCalls",
  "getState",
  "getToolCalls",
  "requiresApproval",
] as const;

type OpenRouterCallModelTurnTraceContext = ChannelMessage<
  typeof openRouterChannels.callModelTurn
>;

type OpenRouterCallModelResultLike = {
  [OPENROUTER_WRAPPED_CALL_MODEL_RESULT]?: true;
  allToolExecutionRounds?: unknown;
  finalResponse?: unknown;
  getInitialResponse?: (...args: unknown[]) => Promise<unknown>;
  getResponse?: (...args: unknown[]) => Promise<unknown>;
  makeFollowupRequest?: (...args: unknown[]) => Promise<unknown>;
  resolvedRequest?: unknown;
  getText?: (...args: unknown[]) => Promise<unknown>;
  [key: string]: unknown;
};

function patchOpenRouterCallModelResult(args: {
  request?: OpenRouterCallModelRequest;
  result: unknown;
  span: Span;
}): boolean {
  const { request, result, span } = args;
  if (!isObject(result) || isWrappedCallModelResult(result)) {
    return false;
  }

  const resultLike = result as OpenRouterCallModelResultLike;
  const hasInstrumentableMethod =
    typeof resultLike.getResponse === "function" ||
    typeof resultLike.getText === "function" ||
    OPENROUTER_CALL_MODEL_STREAM_METHODS.some(
      (methodName) => typeof resultLike[methodName] === "function",
    );

  if (!hasInstrumentableMethod) {
    return false;
  }

  Object.defineProperty(resultLike, OPENROUTER_WRAPPED_CALL_MODEL_RESULT, {
    value: true,
    enumerable: false,
    configurable: false,
  });

  const originalGetResponse =
    typeof resultLike.getResponse === "function"
      ? resultLike.getResponse.bind(resultLike)
      : undefined;
  const originalGetInitialResponse =
    typeof resultLike.getInitialResponse === "function"
      ? resultLike.getInitialResponse.bind(resultLike)
      : undefined;
  const originalMakeFollowupRequest =
    typeof resultLike.makeFollowupRequest === "function"
      ? resultLike.makeFollowupRequest.bind(resultLike)
      : undefined;

  let ended = false;
  let tracedTurnCount = 0;

  const endSpanWithResult = async (
    response?: unknown,
    fallbackOutput?: unknown,
  ) => {
    if (ended) {
      return;
    }
    ended = true;

    const finalResponse = getFinalOpenRouterCallModelResponse(
      resultLike,
      response,
    );
    if (finalResponse) {
      const rounds = getOpenRouterCallModelRounds(resultLike);

      const metadata = extractOpenRouterCallModelResultMetadata(
        finalResponse,
        rounds.length + 1,
      );
      span.log({
        output: extractOpenRouterResponseOutput(finalResponse, fallbackOutput),
        ...(metadata ? { metadata } : {}),
        metrics: aggregateOpenRouterCallModelMetrics(rounds, finalResponse),
      });
      span.end();
      return;
    }

    if (fallbackOutput !== undefined) {
      span.log({
        output: fallbackOutput,
      });
    }

    span.end();
  };

  const endSpanWithError = (error: unknown) => {
    if (ended) {
      return;
    }
    ended = true;
    span.log({
      error: normalizeError(error).message,
    });
    span.end();
  };

  const finalizeFromResponse = async (fallbackOutput?: unknown) => {
    if (!originalGetResponse) {
      await endSpanWithResult(undefined, fallbackOutput);
      return;
    }

    try {
      await endSpanWithResult(await originalGetResponse(), fallbackOutput);
    } catch {
      await endSpanWithResult(undefined, fallbackOutput);
    }
  };

  if (originalGetResponse) {
    resultLike.getResponse = async (...args: unknown[]) => {
      return await withCurrent(span, async () => {
        try {
          const response = await originalGetResponse(...args);
          await endSpanWithResult(response);
          return response;
        } catch (error) {
          endSpanWithError(error);
          throw error;
        }
      });
    };
  }

  if (typeof resultLike.getText === "function") {
    const originalGetText = resultLike.getText.bind(resultLike);
    resultLike.getText = async (...args: unknown[]) => {
      return await withCurrent(span, async () => {
        try {
          const text = await originalGetText(...args);
          await finalizeFromResponse(text);
          return text;
        } catch (error) {
          endSpanWithError(error);
          throw error;
        }
      });
    };
  }

  for (const methodName of OPENROUTER_CALL_MODEL_CONTEXT_METHODS) {
    if (typeof resultLike[methodName] !== "function") {
      continue;
    }

    const originalMethod = resultLike[methodName] as (
      ...args: unknown[]
    ) => Promise<unknown>;
    resultLike[methodName] = async (...args: unknown[]) => {
      return await withCurrent(span, async () => {
        return await originalMethod.apply(resultLike, args);
      });
    };
  }

  for (const methodName of OPENROUTER_CALL_MODEL_STREAM_METHODS) {
    if (typeof resultLike[methodName] !== "function") {
      continue;
    }

    const originalMethod = resultLike[methodName] as (
      ...args: unknown[]
    ) => AsyncIterable<unknown>;
    resultLike[methodName] = (...args: unknown[]) => {
      const stream = withCurrent(span, () =>
        originalMethod.apply(resultLike, args),
      );
      if (!isAsyncIterable(stream)) {
        return stream;
      }

      return wrapAsyncIterableWithSpan({
        finalize: finalizeFromResponse,
        iteratorFactory: () => stream[Symbol.asyncIterator](),
        onError: endSpanWithError,
        span,
      });
    };
  }

  if (originalGetInitialResponse) {
    let initialTurnTraced = false;
    resultLike.getInitialResponse = async (...args: unknown[]) => {
      if (initialTurnTraced) {
        return await withCurrent(span, async () => {
          return await originalGetInitialResponse(...args);
        });
      }

      initialTurnTraced = true;
      const step = tracedTurnCount + 1;
      const stepType = tracedTurnCount === 0 ? "initial" : "continue";

      const response = await traceOpenRouterCallModelTurn({
        fn: async () => {
          const nextResponse = await originalGetInitialResponse(...args);
          tracedTurnCount++;
          return nextResponse;
        },
        parentSpan: span,
        request: getOpenRouterResolvedRequest(resultLike, request),
        step,
        stepType,
      });

      return response;
    };
  }

  if (originalMakeFollowupRequest) {
    resultLike.makeFollowupRequest = async (...args: unknown[]) => {
      const currentResponse = args[0];
      const toolResults = Array.isArray(args[1]) ? args[1] : [];
      const step = tracedTurnCount + 1;

      const response = await traceOpenRouterCallModelTurn({
        fn: async () => {
          const nextResponse = await originalMakeFollowupRequest(...args);
          tracedTurnCount++;
          return nextResponse;
        },
        parentSpan: span,
        request: buildOpenRouterFollowupRequest(
          getOpenRouterResolvedRequest(resultLike, request),
          currentResponse,
          toolResults,
        ),
        step,
        stepType: "continue",
      });

      return response;
    };
  }

  return true;
}

async function traceOpenRouterCallModelTurn<TResult>(args: {
  fn: () => Promise<TResult>;
  parentSpan: Span;
  request: OpenRouterCallModelRequest | undefined;
  step: number;
  stepType: "initial" | "continue";
}): Promise<TResult> {
  const context: OpenRouterCallModelTurnTraceContext = {
    arguments: [args.request],
    step: args.step,
    stepType: args.stepType,
  };

  return await withCurrent(args.parentSpan, () =>
    openRouterChannels.callModelTurn.tracePromise(args.fn, context),
  );
}

function isWrappedCallModelResult(value: unknown): boolean {
  return Boolean(
    isObject(value) &&
    (value as OpenRouterCallModelResultLike)[
      OPENROUTER_WRAPPED_CALL_MODEL_RESULT
    ],
  );
}

function extractOpenRouterCallModelResultMetadata(
  response: Record<string, unknown>,
  turnCount?: number,
): Record<string, unknown> | undefined {
  const combined = {
    ...(extractOpenRouterResponseMetadata(response) || {}),
    ...(turnCount !== undefined ? { turn_count: turnCount } : {}),
  };

  return Object.keys(combined).length > 0 ? combined : undefined;
}

function getFinalOpenRouterCallModelResponse(
  result: OpenRouterCallModelResultLike,
  response: unknown,
): Record<string, unknown> | undefined {
  if (isObject(response)) {
    return response;
  }

  return isObject(result.finalResponse)
    ? (result.finalResponse as Record<string, unknown>)
    : undefined;
}

type OpenRouterCallModelRound = {
  response?: Record<string, unknown>;
  round?: number;
  toolResults?: unknown[];
};

function getOpenRouterCallModelRounds(
  result: OpenRouterCallModelResultLike,
): OpenRouterCallModelRound[] {
  if (!Array.isArray(result.allToolExecutionRounds)) {
    return [];
  }

  return result.allToolExecutionRounds
    .filter((round): round is Record<string, unknown> => isObject(round))
    .map((round) => ({
      response: isObject(round.response)
        ? (round.response as Record<string, unknown>)
        : undefined,
      round: typeof round.round === "number" ? round.round : undefined,
      toolResults: Array.isArray(round.toolResults) ? round.toolResults : [],
    }))
    .filter((round) => round.response !== undefined);
}

function aggregateOpenRouterCallModelMetrics(
  rounds: OpenRouterCallModelRound[],
  finalResponse: Record<string, unknown>,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  const responses = [
    ...rounds.map((round) => round.response).filter(isObject),
    finalResponse,
  ];

  for (const response of responses) {
    const responseMetrics = parseOpenRouterMetricsFromUsage(response.usage);
    for (const [name, value] of Object.entries(responseMetrics)) {
      metrics[name] = (metrics[name] || 0) + value;
    }
  }

  return metrics;
}

function buildNextOpenRouterCallModelInput(
  currentInput: unknown,
  response: Record<string, unknown>,
  toolResults: unknown[],
): unknown {
  const normalizedInput = Array.isArray(currentInput)
    ? [...currentInput]
    : currentInput === undefined
      ? []
      : [currentInput];
  const responseOutput = Array.isArray(response.output)
    ? response.output
    : response.output === undefined
      ? []
      : [response.output];

  return [...normalizedInput, ...responseOutput, ...toolResults].map((entry) =>
    sanitizeOpenRouterLoggedValue(entry),
  );
}

function getOpenRouterResolvedRequest(
  result: OpenRouterCallModelResultLike,
  request: OpenRouterCallModelRequest | undefined,
): OpenRouterCallModelRequest | undefined {
  if (isObject(result.resolvedRequest)) {
    return result.resolvedRequest as OpenRouterCallModelRequest;
  }

  return request;
}

function buildOpenRouterFollowupRequest(
  request: OpenRouterCallModelRequest | undefined,
  currentResponse: unknown,
  toolResults: unknown[],
): OpenRouterCallModelRequest | undefined {
  if (!request) {
    return undefined;
  }

  return {
    ...request,
    input: buildNextOpenRouterCallModelInput(
      extractOpenRouterCallModelInput(request),
      isObject(currentResponse)
        ? (currentResponse as Record<string, unknown>)
        : {},
      toolResults,
    ),
    stream: false,
  };
}

function wrapAsyncIterableWithSpan(args: {
  finalize: (fallbackOutput?: unknown) => Promise<void>;
  iteratorFactory: () => AsyncIterator<unknown>;
  onError: (error: unknown) => void;
  span: Span;
}): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = args.iteratorFactory();
      return {
        next(value?: unknown) {
          return withCurrent(args.span, () =>
            value === undefined
              ? iterator.next()
              : (
                  iterator.next as (
                    value: unknown,
                  ) => Promise<IteratorResult<unknown>>
                )(value),
          ).then(
            async (result) => {
              if (result.done) {
                await args.finalize();
              }
              return result;
            },
            (error) => {
              args.onError(error);
              throw error;
            },
          );
        },
        return(value?: unknown) {
          if (typeof iterator.return !== "function") {
            return args.finalize().then(() => ({
              done: true,
              value,
            }));
          }

          return withCurrent(args.span, () => iterator.return!(value)).then(
            async (result) => {
              await args.finalize();
              return result;
            },
            (error) => {
              args.onError(error);
              throw error;
            },
          );
        },
        throw(error?: unknown) {
          args.onError(error);
          if (typeof iterator.throw !== "function") {
            return Promise.reject(error);
          }
          return withCurrent(args.span, () => iterator.throw!(error));
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export { parseOpenRouterMetricsFromUsage };
