import { SpanTypeAttribute, isObject } from "../../../util/index";
import {
  startSpan as startBaseSpan,
  withCurrent,
  type Span,
} from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  BedrockAgentRuntimeInvokeAgentRequest,
  BedrockAgentRuntimeInvokeInlineAgentRequest,
  BedrockAgentRuntimeResponse,
  BedrockAgentRuntimeRetrieveAndGenerateRequest,
  BedrockAgentRuntimeStreamEvent,
  BedrockAgentRuntimeTracePart,
} from "../../vendor-sdk-types/bedrock-agent-runtime";
import { BasePlugin } from "../core";
import type { AnyAsyncChannel } from "../core/channel-definitions";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import {
  bedrockAgentRuntimeChannels,
  bedrockAgentSmithyClientChannels,
  bedrockAgentSmithyCoreChannels,
} from "./bedrock-agent-runtime-channels";
import {
  getBedrockAgentRuntimeCommandInput,
  getBedrockAgentRuntimeCommandName,
  getBedrockAgentRuntimeOperation,
  type BedrockAgentRuntimeOperation,
} from "./bedrock-agent-runtime-common";

type ChildSpanState = {
  span: Span;
};

type AgentStreamState = {
  citations: unknown[];
  error?: Error;
  files: unknown[];
  firstChunkTime?: number;
  guardrailAction?: string;
  llmSpans: Map<string, ChildSpanState>;
  metrics: Record<string, number>;
  parentSpan: Span;
  returnControl?: unknown;
  text: string;
  toolSpans: Map<string, ChildSpanState>;
};

const STREAM_EXCEPTION_KEYS = [
  "internalServerException",
  "validationException",
  "resourceNotFoundException",
  "serviceQuotaExceededException",
  "throttlingException",
  "accessDeniedException",
  "conflictException",
  "dependencyFailedException",
  "badGatewayException",
  "modelNotReadyException",
] as const;

export class BedrockAgentRuntimePlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      ...[
        bedrockAgentRuntimeChannels.clientSend,
        bedrockAgentSmithyCoreChannels.clientSend,
        bedrockAgentSmithyClientChannels.clientSend,
      ].map((channel) => traceBedrockAgentRuntimeClientSendChannel(channel)),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function traceBedrockAgentRuntimeClientSendChannel(
  channel: AnyAsyncChannel,
): () => void {
  return traceStreamingChannel(channel, {
    name: ([command]) => {
      const operation = getBedrockAgentRuntimeOperation(command);
      return operation
        ? `bedrockAgent.${operation}`
        : "bedrockAgent.client.send";
    },
    shouldTrace: ([command, optionsOrCb, cb]) =>
      getBedrockAgentRuntimeOperation(command) !== undefined &&
      typeof optionsOrCb !== "function" &&
      typeof cb !== "function",
    type: SpanTypeAttribute.TASK,
    extractInput: ([command]) => extractBedrockAgentRuntimeInput(command),
    extractOutput: (result, endEvent) =>
      extractBedrockAgentRuntimeOutput(endEvent?.arguments?.[0], result),
    extractMetadata: (result) =>
      extractBedrockAgentRuntimeResponseMetadata(result),
    extractMetrics: () => ({}),
    patchResult: ({ endEvent, result, span, startTime }) =>
      patchBedrockAgentRuntimeStreamingResult({
        command: endEvent.arguments?.[0],
        result,
        span,
        startTime,
      }),
  });
}

function extractBedrockAgentRuntimeInput(command: unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const operation = getBedrockAgentRuntimeOperation(command);
  const commandName = getBedrockAgentRuntimeCommandName(command);
  const request = getBedrockAgentRuntimeCommandInput(command);
  const metadata = {
    provider: "aws-bedrock",
    ...(commandName ? { command: commandName } : {}),
    ...(operation ? { operation } : {}),
    ...extractRequestMetadata(request, operation),
  };

  if (operation === "invokeAgent") {
    const invokeRequest = request as
      | BedrockAgentRuntimeInvokeAgentRequest
      | undefined;
    return {
      input:
        invokeRequest?.inputText ??
        sanitizeBedrockAgentValue(invokeRequest?.sessionState),
      metadata,
    };
  }

  if (operation === "invokeInlineAgent") {
    const inlineRequest = request as
      | BedrockAgentRuntimeInvokeInlineAgentRequest
      | undefined;
    return {
      input:
        inlineRequest?.inputText ??
        sanitizeBedrockAgentValue(inlineRequest?.inlineSessionState),
      metadata,
    };
  }

  if (
    operation === "retrieveAndGenerate" ||
    operation === "retrieveAndGenerateStream"
  ) {
    return {
      input: sanitizeBedrockAgentValue(
        (request as BedrockAgentRuntimeRetrieveAndGenerateRequest | undefined)
          ?.input,
      ),
      metadata,
    };
  }

  return {
    input: sanitizeBedrockAgentValue(request),
    metadata,
  };
}

function extractRequestMetadata(
  request: unknown,
  operation: BedrockAgentRuntimeOperation | undefined,
): Record<string, unknown> {
  if (!isObject(request)) {
    return {};
  }

  const metadata: Record<string, unknown> = {};
  for (const key of [
    "agentId",
    "agentAliasId",
    "agentName",
    "sessionId",
    "memoryId",
    "enableTrace",
    "endSession",
  ]) {
    if (request[key] !== undefined) {
      metadata[key] = sanitizeBedrockAgentValue(request[key]);
    }
  }

  if (typeof request.foundationModel === "string") {
    metadata.model = request.foundationModel;
  }
  if (
    operation === "invokeInlineAgent" &&
    Array.isArray(request.actionGroups)
  ) {
    metadata.tools = sanitizeBedrockAgentValue(request.actionGroups);
  }

  const retrieveConfiguration = request.retrieveAndGenerateConfiguration;
  if (isObject(retrieveConfiguration)) {
    const knowledgeBaseConfiguration = isObject(
      retrieveConfiguration.knowledgeBaseConfiguration,
    )
      ? retrieveConfiguration.knowledgeBaseConfiguration
      : undefined;
    const externalSourcesConfiguration = isObject(
      retrieveConfiguration.externalSourcesConfiguration,
    )
      ? retrieveConfiguration.externalSourcesConfiguration
      : undefined;
    if (typeof knowledgeBaseConfiguration?.knowledgeBaseId === "string") {
      metadata.knowledgeBaseId = knowledgeBaseConfiguration.knowledgeBaseId;
    }
    const modelArn =
      knowledgeBaseConfiguration?.modelArn ??
      externalSourcesConfiguration?.modelArn;
    if (typeof modelArn === "string") {
      metadata.model = modelArn;
    }
  }

  return metadata;
}

function extractBedrockAgentRuntimeOutput(
  command: unknown,
  result: unknown,
): unknown {
  const operation = getBedrockAgentRuntimeOperation(command);
  if (!isObject(result)) {
    return sanitizeBedrockAgentValue(result);
  }

  if (operation === "retrieveAndGenerate") {
    return {
      text: isObject(result.output) ? result.output.text : undefined,
      ...(result.citations !== undefined
        ? { citations: sanitizeBedrockAgentValue(result.citations) }
        : {}),
    };
  }

  return sanitizeBedrockAgentValue(result);
}

function extractBedrockAgentRuntimeResponseMetadata(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  for (const key of [
    "contentType",
    "sessionId",
    "memoryId",
    "guardrailAction",
  ]) {
    if (result[key] !== undefined) {
      metadata[key] = sanitizeBedrockAgentValue(result[key]);
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function patchBedrockAgentRuntimeStreamingResult(args: {
  command: unknown;
  result: unknown;
  span: Span;
  startTime: number;
}): boolean {
  const operation = getBedrockAgentRuntimeOperation(args.command);
  if (!isObject(args.result) || !operation) {
    return false;
  }

  const response = args.result as BedrockAgentRuntimeResponse;
  const stream =
    operation === "retrieveAndGenerateStream"
      ? response.stream
      : operation === "invokeAgent" || operation === "invokeInlineAgent"
        ? response.completion
        : undefined;
  if (!isAsyncIterable(stream)) {
    return false;
  }

  const state: AgentStreamState = {
    citations: [],
    files: [],
    llmSpans: new Map(),
    metrics: {},
    parentSpan: args.span,
    text: "",
    toolSpans: new Map(),
  };

  patchStreamIfNeeded<BedrockAgentRuntimeStreamEvent>(stream, {
    onChunk: (chunk) => {
      const hasGeneratedText = handleStreamEvent(state, chunk);
      if (hasGeneratedText && state.firstChunkTime === undefined) {
        state.firstChunkTime = getCurrentUnixTimestamp();
      }
    },
    onComplete: () => {
      finalizeOpenChildSpans(state, state.error);
      const metrics = { ...state.metrics };
      if (state.firstChunkTime !== undefined) {
        metrics.time_to_first_token = state.firstChunkTime - args.startTime;
      }

      args.span.log({
        ...(state.error
          ? { error: state.error }
          : { output: buildStreamOutput(state) }),
        metrics,
        metadata: {
          ...extractBedrockAgentRuntimeResponseMetadata(response),
          ...(state.guardrailAction !== undefined
            ? { guardrailAction: state.guardrailAction }
            : {}),
        },
      });
      args.span.end();
    },
    onError: (error) => {
      finalizeOpenChildSpans(state, error);
      args.span.log({ error });
      args.span.end();
    },
  });
  return true;
}

function handleStreamEvent(
  state: AgentStreamState,
  event: BedrockAgentRuntimeStreamEvent,
): boolean {
  const exception = extractStreamException(event);
  if (exception && !state.error) {
    state.error = exception;
  }

  const chunkText = decodeBytes(event.chunk?.bytes);
  if (chunkText !== undefined) {
    state.text += chunkText;
  }
  if (typeof event.output?.text === "string") {
    state.text += event.output.text;
  }
  if (event.chunk?.attribution !== undefined) {
    state.citations.push(sanitizeBedrockAgentValue(event.chunk.attribution));
  }
  if (event.citation !== undefined) {
    state.citations.push(sanitizeBedrockAgentValue(event.citation));
  }
  if (typeof event.guardrail?.action === "string") {
    state.guardrailAction = event.guardrail.action;
  }
  if (event.returnControl !== undefined) {
    state.returnControl = sanitizeBedrockAgentValue(event.returnControl);
  }
  if (event.files !== undefined) {
    state.files.push(sanitizeBedrockAgentValue(event.files));
  }
  if (event.trace) {
    handleTracePart(state, event.trace);
  }
  return chunkText !== undefined || typeof event.output?.text === "string";
}

function handleTracePart(
  state: AgentStreamState,
  tracePart: BedrockAgentRuntimeTracePart,
): void {
  const trace = tracePart.trace;
  if (!isObject(trace)) {
    return;
  }

  for (const [traceType, traceValue] of Object.entries(trace)) {
    if (!isObject(traceValue)) {
      continue;
    }

    if (isObject(traceValue.modelInvocationInput)) {
      startModelSpan(
        state,
        traceType,
        traceValue.modelInvocationInput,
        tracePart,
      );
    }
    if (isObject(traceValue.modelInvocationOutput)) {
      finishModelSpan(
        state,
        traceType,
        traceValue.modelInvocationOutput,
        tracePart,
      );
    }
    if (isObject(traceValue.invocationInput)) {
      startToolSpan(state, traceType, traceValue.invocationInput, tracePart);
    }
    if (isObject(traceValue.observation)) {
      finishToolSpan(state, traceType, traceValue.observation, tracePart);
    }
  }

  if (
    isObject(trace.failureTrace) &&
    typeof trace.failureTrace.failureReason === "string" &&
    !state.error
  ) {
    state.error = new Error(trace.failureTrace.failureReason);
  }
}

function startModelSpan(
  state: AgentStreamState,
  traceType: string,
  input: Record<string, unknown>,
  tracePart: BedrockAgentRuntimeTracePart,
): void {
  const traceId = getTraceId(input);
  if (!traceId || state.llmSpans.has(traceId)) {
    return;
  }

  const metadata: Record<string, unknown> = {
    provider: "aws-bedrock",
    trace_type: traceType,
    ...extractTracePartMetadata(tracePart),
  };
  if (typeof input.foundationModel === "string") {
    metadata.model = input.foundationModel;
  }
  if (typeof input.type === "string") {
    metadata.prompt_type = input.type;
  }
  if (isObject(input.inferenceConfiguration)) {
    Object.assign(
      metadata,
      sanitizeBedrockAgentValue(input.inferenceConfiguration),
    );
  }

  const span = withCurrent(state.parentSpan, () =>
    startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: input.text,
            metadata,
          },
          name: "bedrockAgent.modelInvocation",
          spanAttributes: { type: SpanTypeAttribute.LLM },
        },
        INSTRUMENTATION_NAMES.BEDROCK_AGENT_RUNTIME,
      ),
    ),
  );
  state.llmSpans.set(traceId, { span });
}

function finishModelSpan(
  state: AgentStreamState,
  traceType: string,
  output: Record<string, unknown>,
  tracePart: BedrockAgentRuntimeTracePart,
): void {
  const traceId = getTraceId(output);
  if (!traceId) {
    return;
  }

  let child = state.llmSpans.get(traceId);
  if (!child) {
    startModelSpan(state, traceType, { traceId }, tracePart);
    child = state.llmSpans.get(traceId);
  }
  if (!child) {
    return;
  }

  const metrics = extractModelMetrics(output);
  addMetrics(state.metrics, metrics);
  child.span.log({
    output: extractModelOutput(output),
    metrics,
  });
  child.span.end();
  state.llmSpans.delete(traceId);
}

function startToolSpan(
  state: AgentStreamState,
  traceType: string,
  input: Record<string, unknown>,
  tracePart: BedrockAgentRuntimeTracePart,
): void {
  const traceId = getTraceId(input);
  if (!traceId || state.toolSpans.has(traceId)) {
    return;
  }

  const tool = extractToolInput(input);
  if (!tool) {
    return;
  }
  const span = withCurrent(state.parentSpan, () =>
    startBaseSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: tool.input,
            metadata: {
              provider: "aws-bedrock",
              tool_type: tool.type,
              trace_type: traceType,
              ...tool.metadata,
              ...extractTracePartMetadata(tracePart),
            },
          },
          name: tool.name,
          spanAttributes: { type: SpanTypeAttribute.TOOL },
        },
        INSTRUMENTATION_NAMES.BEDROCK_AGENT_RUNTIME,
      ),
    ),
  );
  state.toolSpans.set(traceId, { span });
}

function finishToolSpan(
  state: AgentStreamState,
  _traceType: string,
  observation: Record<string, unknown>,
  _tracePart: BedrockAgentRuntimeTracePart,
): void {
  const traceId = getTraceId(observation);
  if (!traceId) {
    return;
  }

  const child = state.toolSpans.get(traceId);
  if (!child) {
    return;
  }
  child.span.log({ output: extractToolOutput(observation) });
  child.span.end();
  state.toolSpans.delete(traceId);
}

function extractToolInput(input: Record<string, unknown>):
  | {
      input: unknown;
      metadata: Record<string, unknown>;
      name: string;
      type: string;
    }
  | undefined {
  if (isObject(input.actionGroupInvocationInput)) {
    const action = input.actionGroupInvocationInput;
    const name =
      (typeof action.function === "string" && action.function) ||
      (typeof action.apiPath === "string" && action.apiPath) ||
      (typeof action.actionGroupName === "string" && action.actionGroupName) ||
      "bedrockAgent.actionGroup";
    return {
      input: sanitizeBedrockAgentValue({
        parameters: action.parameters,
        requestBody: action.requestBody,
      }),
      metadata: {
        ...(typeof action.actionGroupName === "string"
          ? { action_group: action.actionGroupName }
          : {}),
        ...(typeof action.verb === "string" ? { verb: action.verb } : {}),
      },
      name,
      type: "action_group",
    };
  }

  if (isObject(input.knowledgeBaseLookupInput)) {
    const lookup = input.knowledgeBaseLookupInput;
    return {
      input: lookup.text,
      metadata: {
        ...(typeof lookup.knowledgeBaseId === "string"
          ? { knowledge_base_id: lookup.knowledgeBaseId }
          : {}),
      },
      name: "bedrockAgent.knowledgeBaseLookup",
      type: "knowledge_base",
    };
  }

  if (isObject(input.codeInterpreterInvocationInput)) {
    return {
      input: sanitizeBedrockAgentValue(input.codeInterpreterInvocationInput),
      metadata: {},
      name: "bedrockAgent.codeInterpreter",
      type: "code_interpreter",
    };
  }

  if (isObject(input.agentCollaboratorInvocationInput)) {
    return {
      input: sanitizeBedrockAgentValue(input.agentCollaboratorInvocationInput),
      metadata: {},
      name: "bedrockAgent.collaborator",
      type: "agent_collaborator",
    };
  }

  return undefined;
}

function extractToolOutput(observation: Record<string, unknown>): unknown {
  for (const key of [
    "actionGroupInvocationOutput",
    "knowledgeBaseLookupOutput",
    "codeInterpreterInvocationOutput",
    "agentCollaboratorInvocationOutput",
  ]) {
    if (observation[key] !== undefined) {
      return sanitizeBedrockAgentValue(observation[key]);
    }
  }
  return sanitizeBedrockAgentValue(observation);
}

function extractModelOutput(output: Record<string, unknown>): unknown {
  const rawResponse = isObject(output.rawResponse)
    ? output.rawResponse
    : undefined;
  const parsedResponse = isObject(output.parsedResponse)
    ? output.parsedResponse
    : undefined;
  const content =
    rawResponse?.content ??
    parsedResponse?.text ??
    parsedResponse?.isValid ??
    undefined;
  const parsedContent =
    typeof content === "string" ? (parseJson(content) ?? content) : content;

  if (output.reasoningContent !== undefined) {
    return {
      content: sanitizeBedrockAgentValue(parsedContent),
      reasoning: sanitizeBedrockAgentValue(output.reasoningContent),
    };
  }
  return sanitizeBedrockAgentValue(parsedContent ?? output);
}

function extractModelMetrics(
  output: Record<string, unknown>,
): Record<string, number> {
  const metadata = isObject(output.metadata) ? output.metadata : undefined;
  const usage = isObject(metadata?.usage) ? metadata.usage : undefined;
  const metrics: Record<string, number> = {};
  if (typeof usage?.inputTokens === "number") {
    metrics.prompt_tokens = usage.inputTokens;
  }
  if (typeof usage?.outputTokens === "number") {
    metrics.completion_tokens = usage.outputTokens;
  }
  if (
    metrics.prompt_tokens !== undefined ||
    metrics.completion_tokens !== undefined
  ) {
    metrics.tokens =
      (metrics.prompt_tokens ?? 0) + (metrics.completion_tokens ?? 0);
  }
  return metrics;
}

function addMetrics(
  target: Record<string, number>,
  metrics: Record<string, number>,
): void {
  for (const key of ["prompt_tokens", "completion_tokens", "tokens"]) {
    const value = metrics[key];
    if (typeof value === "number") {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

function extractTracePartMetadata(
  tracePart: BedrockAgentRuntimeTracePart,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of [
    "agentId",
    "agentAliasId",
    "agentVersion",
    "collaboratorName",
    "sessionId",
  ]) {
    if (tracePart[key] !== undefined) {
      metadata[key] = sanitizeBedrockAgentValue(tracePart[key]);
    }
  }
  return metadata;
}

function finalizeOpenChildSpans(state: AgentStreamState, error?: Error): void {
  for (const child of [
    ...state.llmSpans.values(),
    ...state.toolSpans.values(),
  ]) {
    if (error) {
      child.span.log({ error });
    }
    child.span.end();
  }
  state.llmSpans.clear();
  state.toolSpans.clear();
}

function buildStreamOutput(state: AgentStreamState): unknown {
  return {
    text: state.text,
    ...(state.citations.length > 0
      ? { citations: state.citations.slice(0, 50) }
      : {}),
    ...(state.returnControl !== undefined
      ? { returnControl: state.returnControl }
      : {}),
    ...(state.files.length > 0 ? { files: state.files.slice(0, 20) } : {}),
  };
}

function extractStreamException(
  event: BedrockAgentRuntimeStreamEvent,
): Error | undefined {
  for (const key of STREAM_EXCEPTION_KEYS) {
    const value = event[key];
    if (!isObject(value)) {
      continue;
    }
    const message =
      typeof value.message === "string"
        ? value.message
        : typeof value.name === "string"
          ? value.name
          : key;
    return new Error(`${key}: ${message}`);
  }
  return undefined;
}

function getTraceId(value: Record<string, unknown>): string | undefined {
  return typeof value.traceId === "string" ? value.traceId : undefined;
}

function decodeBytes(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(value));
  }
  return undefined;
}

function parseJson(value: string): unknown | undefined {
  try {
    return sanitizeBedrockAgentValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function sanitizeBedrockAgentValue(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return { byte_length: value.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { byte_length: value.byteLength };
  }
  if (depth > 20) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeBedrockAgentValue(entry, depth + 1));
  }
  if (!isObject(value)) {
    return String(value);
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      continue;
    }
    output[key] = sanitizeBedrockAgentValue(nested, depth + 1);
  }
  return output;
}
