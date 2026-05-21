/* eslint-disable @typescript-eslint/no-explicit-any */
import { SpanTypeAttribute, isObject } from "../../../util/index";
import {
  type Logger,
  type Span as BraintrustSpan,
  NOOP_SPAN,
  currentSpan,
  startSpan,
} from "../../logger";
import type {
  OpenAIAgentsAgentSpanData,
  OpenAIAgentsCustomSpanData,
  OpenAIAgentsFunctionSpanData,
  OpenAIAgentsGenerationSpanData,
  OpenAIAgentsGuardrailSpanData,
  OpenAIAgentsHandoffSpanData,
  OpenAIAgentsMCPListToolsSpanData,
  OpenAIAgentsResponseSpanData,
  OpenAIAgentsSpan,
  OpenAIAgentsSpanData,
  OpenAIAgentsSpeechGroupSpanData,
  OpenAIAgentsSpeechSpanData,
  OpenAIAgentsTrace,
  OpenAIAgentsTranscriptionSpanData,
} from "../../vendor-sdk-types/openai-agents";

type SpanInput =
  | string
  | Array<Record<string, unknown>>
  | Record<string, unknown>[];

type SpanOutput =
  | string
  | Array<Record<string, unknown>>
  | Record<string, unknown>;

type TraceMetadata = {
  firstInput: SpanInput | null;
  lastOutput: SpanOutput | null;
};

export interface OpenAIAgentsTraceProcessorOptions {
  logger?: Logger<any>;
  maxTraces?: number;
}

function isSpanData<T extends OpenAIAgentsSpanData["type"]>(
  spanData: OpenAIAgentsSpanData,
  type: T,
): spanData is Extract<OpenAIAgentsSpanData, { type: T }> {
  return spanData.type === type;
}

function spanTypeFromAgents(span: OpenAIAgentsSpan): SpanTypeAttribute {
  const spanType = span.spanData.type;

  if (
    spanType === "function" ||
    spanType === "guardrail" ||
    spanType === "mcp_tools"
  ) {
    return SpanTypeAttribute.TOOL;
  }

  if (
    spanType === "generation" ||
    spanType === "response" ||
    spanType === "transcription" ||
    spanType === "speech"
  ) {
    return SpanTypeAttribute.LLM;
  }

  return SpanTypeAttribute.TASK;
}

function spanNameFromAgents(span: OpenAIAgentsSpan): string {
  const spanData = span.spanData;
  if ("name" in spanData && spanData.name) {
    return spanData.name;
  }

  switch (spanData.type) {
    case "generation":
      return "Generation";
    case "response":
      return "Response";
    case "handoff":
      return "Handoff";
    case "mcp_tools":
      return isSpanData(spanData, "mcp_tools") && spanData.server
        ? `List Tools (${spanData.server})`
        : "MCP List Tools";
    case "transcription":
      return "Transcription";
    case "speech":
      return "Speech";
    case "speech_group":
      return "Speech Group";
    default:
      return "Unknown";
  }
}

function getTimeElapsed(end?: string, start?: string): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
    return undefined;
  }
  return (endTime - startTime) / 1000;
}

function getNumberProperty(obj: unknown, key: string): number | undefined {
  if (!isObject(obj) || !(key in obj)) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === "number" ? value : undefined;
}

function parseUsageMetrics(usage: unknown): Record<string, number> {
  const metrics: Record<string, number> = {};
  if (!isObject(usage)) {
    return metrics;
  }

  const promptTokens =
    getNumberProperty(usage, "prompt_tokens") ??
    getNumberProperty(usage, "input_tokens") ??
    getNumberProperty(usage, "promptTokens") ??
    getNumberProperty(usage, "inputTokens");
  const completionTokens =
    getNumberProperty(usage, "completion_tokens") ??
    getNumberProperty(usage, "output_tokens") ??
    getNumberProperty(usage, "completionTokens") ??
    getNumberProperty(usage, "outputTokens");
  const totalTokens =
    getNumberProperty(usage, "total_tokens") ??
    getNumberProperty(usage, "totalTokens");

  if (promptTokens !== undefined) {
    metrics.prompt_tokens = promptTokens;
  }
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  } else if (promptTokens !== undefined && completionTokens !== undefined) {
    metrics.tokens = promptTokens + completionTokens;
  }

  const inputDetails = usage.input_tokens_details;
  const cachedTokens = getNumberProperty(inputDetails, "cached_tokens");
  const cacheWriteTokens = getNumberProperty(
    inputDetails,
    "cache_write_tokens",
  );
  if (cachedTokens !== undefined) {
    metrics.prompt_cached_tokens = cachedTokens;
  }
  if (cacheWriteTokens !== undefined) {
    metrics.prompt_cache_creation_tokens = cacheWriteTokens;
  }

  return metrics;
}

/**
 * Converts OpenAI Agents SDK trace processor lifecycle events into Braintrust spans.
 */
export class OpenAIAgentsTraceProcessor {
  private static readonly DEFAULT_MAX_TRACES = 10000;

  private logger?: Logger<any>;
  private maxTraces: number;
  private traceSpans = new Map<
    string,
    {
      rootSpan: BraintrustSpan;
      childSpans: Map<string, BraintrustSpan>;
      metadata: TraceMetadata;
    }
  >();
  private traceOrder: string[] = [];

  public readonly _traceSpans = this.traceSpans;

  constructor(options: OpenAIAgentsTraceProcessorOptions = {}) {
    this.logger = options.logger;
    this.maxTraces =
      options.maxTraces ?? OpenAIAgentsTraceProcessor.DEFAULT_MAX_TRACES;
  }

  private evictOldestTrace(): void {
    const oldestTraceId = this.traceOrder.shift();
    if (oldestTraceId) {
      this.traceSpans.delete(oldestTraceId);
    }
  }

  onTraceStart(trace: OpenAIAgentsTrace): Promise<void> {
    if (!trace?.traceId) {
      return Promise.resolve();
    }

    if (this.traceOrder.length >= this.maxTraces) {
      this.evictOldestTrace();
    }

    const current = currentSpan();
    const span =
      current && current !== NOOP_SPAN
        ? current.startSpan({
            name: trace.name,
            type: SpanTypeAttribute.TASK,
          })
        : this.logger
          ? this.logger.startSpan({
              name: trace.name,
              type: SpanTypeAttribute.TASK,
            })
          : startSpan({
              name: trace.name,
              type: SpanTypeAttribute.TASK,
            });

    span.log({
      input: "Agent workflow started",
      metadata: {
        group_id: trace.groupId,
        ...(trace.metadata || {}),
      },
    });

    this.traceSpans.set(trace.traceId, {
      rootSpan: span,
      childSpans: new Map(),
      metadata: {
        firstInput: null,
        lastOutput: null,
      },
    });
    this.traceOrder.push(trace.traceId);

    return Promise.resolve();
  }

  async onTraceEnd(trace: OpenAIAgentsTrace): Promise<void> {
    const traceData = this.traceSpans.get(trace?.traceId);
    if (!traceData) {
      return;
    }

    try {
      traceData.rootSpan.log({
        input: traceData.metadata.firstInput,
        output: traceData.metadata.lastOutput,
      });
      traceData.rootSpan.end();
      await traceData.rootSpan.flush();
    } finally {
      this.traceSpans.delete(trace.traceId);
      const orderIndex = this.traceOrder.indexOf(trace.traceId);
      if (orderIndex > -1) {
        this.traceOrder.splice(orderIndex, 1);
      }
    }
  }

  onSpanStart(span: OpenAIAgentsSpan): Promise<void> {
    if (!span?.spanId || !span.traceId) {
      return Promise.resolve();
    }

    const traceData = this.traceSpans.get(span.traceId);
    if (!traceData) {
      return Promise.resolve();
    }

    const parentSpan = span.parentId
      ? traceData.childSpans.get(span.parentId)
      : traceData.rootSpan;
    if (!parentSpan) {
      return Promise.resolve();
    }

    const childSpan = parentSpan.startSpan({
      name: spanNameFromAgents(span),
      type: spanTypeFromAgents(span),
    });
    traceData.childSpans.set(span.spanId, childSpan);

    return Promise.resolve();
  }

  onSpanEnd(span: OpenAIAgentsSpan): Promise<void> {
    if (!span?.spanId || !span.traceId) {
      return Promise.resolve();
    }

    const traceData = this.traceSpans.get(span.traceId);
    if (!traceData) {
      return Promise.resolve();
    }

    const braintrustSpan = traceData.childSpans.get(span.spanId);
    if (!braintrustSpan) {
      return Promise.resolve();
    }

    const logData = this.extractLogData(span);
    braintrustSpan.log({
      error: span.error,
      ...logData,
    });
    braintrustSpan.end();
    traceData.childSpans.delete(span.spanId);

    const input = logData.input as SpanInput;
    const output = logData.output as SpanOutput;
    if (traceData.metadata.firstInput === null && input != null) {
      traceData.metadata.firstInput = input;
    }
    if (output != null) {
      traceData.metadata.lastOutput = output;
    }

    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    if (this.logger && typeof this.logger.flush === "function") {
      await this.logger.flush();
    }
  }

  async forceFlush(): Promise<void> {
    if (this.logger && typeof this.logger.flush === "function") {
      await this.logger.flush();
    }
  }

  private extractLogData(
    span: OpenAIAgentsSpan,
  ): Record<string, unknown> & { input?: unknown; output?: unknown } {
    const spanData = span.spanData;

    switch (spanData.type) {
      case "agent":
        return this.extractAgentLogData(spanData);
      case "response":
        return this.extractResponseLogData(spanData, span);
      case "function":
        return this.extractFunctionLogData(spanData);
      case "handoff":
        return this.extractHandoffLogData(spanData);
      case "guardrail":
        return this.extractGuardrailLogData(spanData);
      case "generation":
        return this.extractGenerationLogData(spanData, span);
      case "custom":
        return this.extractCustomLogData(spanData);
      case "mcp_tools":
        return this.extractMCPListToolsLogData(spanData);
      case "transcription":
        return this.extractTranscriptionLogData(spanData);
      case "speech":
        return this.extractSpeechLogData(spanData);
      case "speech_group":
        return this.extractSpeechGroupLogData(spanData);
      default:
        return {};
    }
  }

  private extractAgentLogData(
    spanData: OpenAIAgentsAgentSpanData,
  ): Record<string, unknown> {
    return {
      metadata: {
        tools: spanData.tools,
        handoffs: spanData.handoffs,
        output_type: spanData.output_type,
      },
    };
  }

  private extractResponseLogData(
    spanData: OpenAIAgentsResponseSpanData,
    span: OpenAIAgentsSpan,
  ): Record<string, unknown> {
    const response = spanData._response;
    const output = isObject(response) ? response.output : undefined;
    const usage = isObject(response) ? response.usage : undefined;
    const metrics = {
      ...this.extractTimingMetrics(span),
      ...parseUsageMetrics(usage),
    };

    return {
      input: spanData._input,
      output,
      metadata: isObject(response)
        ? this.omitKeys(response, ["output", "usage"])
        : {},
      metrics,
    };
  }

  private extractFunctionLogData(
    spanData: OpenAIAgentsFunctionSpanData,
  ): Record<string, unknown> {
    return {
      input: spanData.input,
      output: spanData.output,
    };
  }

  private extractHandoffLogData(
    spanData: OpenAIAgentsHandoffSpanData,
  ): Record<string, unknown> {
    return {
      metadata: {
        from_agent: spanData.from_agent,
        to_agent: spanData.to_agent,
      },
    };
  }

  private extractGuardrailLogData(
    spanData: OpenAIAgentsGuardrailSpanData,
  ): Record<string, unknown> {
    return {
      metadata: {
        triggered: spanData.triggered,
      },
    };
  }

  private extractGenerationLogData(
    spanData: OpenAIAgentsGenerationSpanData,
    span: OpenAIAgentsSpan,
  ): Record<string, unknown> {
    return {
      input: spanData.input,
      output: spanData.output,
      metadata: {
        model: spanData.model,
        model_config: spanData.model_config,
      },
      metrics: {
        ...this.extractTimingMetrics(span),
        ...parseUsageMetrics(spanData.usage),
      },
    };
  }

  private extractCustomLogData(
    spanData: OpenAIAgentsCustomSpanData,
  ): Record<string, unknown> {
    return spanData.data || {};
  }

  private extractMCPListToolsLogData(
    spanData: OpenAIAgentsMCPListToolsSpanData,
  ): Record<string, unknown> {
    return {
      output: spanData.result,
      metadata: {
        server: spanData.server,
      },
    };
  }

  private extractTranscriptionLogData(
    spanData: OpenAIAgentsTranscriptionSpanData,
  ): Record<string, unknown> {
    return {
      input: spanData.input,
      output: spanData.output,
      metadata: {
        model: spanData.model,
        model_config: spanData.model_config,
      },
    };
  }

  private extractSpeechLogData(
    spanData: OpenAIAgentsSpeechSpanData,
  ): Record<string, unknown> {
    return {
      input: spanData.input,
      output: spanData.output,
      metadata: {
        model: spanData.model,
        model_config: spanData.model_config,
      },
    };
  }

  private extractSpeechGroupLogData(
    spanData: OpenAIAgentsSpeechGroupSpanData,
  ): Record<string, unknown> {
    return {
      input: spanData.input,
    };
  }

  private extractTimingMetrics(span: OpenAIAgentsSpan): Record<string, number> {
    const timeToFirstToken = getTimeElapsed(
      span.endedAt ?? undefined,
      span.startedAt ?? undefined,
    );
    return timeToFirstToken === undefined
      ? {}
      : { time_to_first_token: timeToFirstToken };
  }

  private omitKeys(
    value: Record<string, unknown>,
    keys: string[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (!keys.includes(key)) {
        result[key] = fieldValue;
      }
    }
    return result;
  }
}
