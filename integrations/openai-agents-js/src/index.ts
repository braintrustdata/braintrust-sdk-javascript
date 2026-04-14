/* eslint-disable @typescript-eslint/no-explicit-any */
import { SpanTypeAttribute } from "braintrust/util";
import {
  Span as BraintrustSpan,
  startSpan,
  Logger,
  currentSpan,
  NOOP_SPAN,
  Attachment,
} from "braintrust";
import {
  SpanType,
  AgentsTrace,
  AgentsSpan,
  SpanInput,
  SpanOutput,
  TraceMetadata,
  OpenAIAgentsTraceProcessorOptions,
  isResponseSpanData,
  isGenerationSpanData,
  isAgentSpanData,
  isFunctionSpanData,
  isHandoffSpanData,
  isGuardrailSpanData,
  isCustomSpanData,
  isMCPListToolsSpanData,
  isTranscriptionSpanData,
  isSpeechSpanData,
  isSpeechGroupSpanData,
} from "./types";

function spanTypeFromAgents(span: AgentsSpan): SpanTypeAttribute {
  const spanType = span.spanData.type;

  if (
    spanType === SpanType.AGENT ||
    spanType === SpanType.HANDOFF ||
    spanType === SpanType.CUSTOM ||
    spanType === SpanType.SPEECH_GROUP
  ) {
    return SpanTypeAttribute.TASK;
  }

  if (
    spanType === SpanType.FUNCTION ||
    spanType === SpanType.GUARDRAIL ||
    spanType === SpanType.MCP_TOOLS
  ) {
    return SpanTypeAttribute.TOOL;
  }

  if (
    spanType === SpanType.GENERATION ||
    spanType === SpanType.RESPONSE ||
    spanType === SpanType.TRANSCRIPTION ||
    spanType === SpanType.SPEECH
  ) {
    return SpanTypeAttribute.LLM;
  }

  return SpanTypeAttribute.TASK;
}

function spanNameFromAgents(span: AgentsSpan): string {
  const spanData = span.spanData;

  if ("name" in spanData && spanData.name) {
    return spanData.name;
  }

  switch (spanData.type) {
    case SpanType.GENERATION:
      return "Generation";
    case SpanType.RESPONSE:
      return "Response";
    case SpanType.HANDOFF:
      return "Handoff";
    case SpanType.MCP_TOOLS:
      if (isMCPListToolsSpanData(spanData) && spanData.server) {
        return `List Tools (${spanData.server})`;
      }
      return "MCP List Tools";
    case SpanType.TRANSCRIPTION:
      return "Transcription";
    case SpanType.SPEECH:
      return "Speech";
    case SpanType.SPEECH_GROUP:
      return "Speech Group";
    case SpanType.AGENT:
    case SpanType.FUNCTION:
    case SpanType.GUARDRAIL:
    case SpanType.CUSTOM:
      return "name" in spanData && spanData.name ? spanData.name : "Unknown";
    default:
      return "Unknown";
  }
}

function getTimeElapsed(end?: string, start?: string): number | undefined {
  if (!start || !end) return undefined;
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (isNaN(startTime) || isNaN(endTime)) return undefined;
  return (endTime - startTime) / 1000;
}

/**
 * `OpenAIAgentsTraceProcessor` is a tracing processor that logs traces from the OpenAI Agents SDK to Braintrust.
 *
 * Args:
 *   options: Configuration options including:
 *     - logger: A `Span`, `Experiment`, or `Logger` to use for logging.
 *       If `undefined`, the current span, experiment, or logger will be selected exactly as in `startSpan`.
 *     - maxTraces: Maximum number of concurrent traces to keep in memory (default: 1000).
 *       When exceeded, oldest traces are evicted using LRU policy.
 * */

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

  // Expose for testing purposes
  public readonly _traceSpans = this.traceSpans;

  constructor(options: OpenAIAgentsTraceProcessorOptions = {}) {
    this.logger = options.logger;
    this.maxTraces =
      options.maxTraces ?? OpenAIAgentsTraceProcessor.DEFAULT_MAX_TRACES;
  }

  private processInputImages(input: any): any {
    if (Array.isArray(input)) {
      return input.map((item) => this.processInputImages(item));
    }

    if (input && typeof input === "object") {
      // Handle input_image type with base64 image data
      if (input.type === "input_image" && typeof input.image === "string") {
        let imageData = input.image;

        // Strip data URI prefix if present (e.g., "data:image/png;base64,")
        const dataUriMatch = imageData.match(/^data:image\/(\w+);base64,(.*)$/);
        let contentType = "image/png";
        let fileExtension = "png";

        if (dataUriMatch) {
          fileExtension = dataUriMatch[1];
          contentType = `image/${fileExtension}`;
          imageData = dataUriMatch[2]; // Extract just the base64 part
        }

        const filename = `input_image.${fileExtension}`;

        try {
          // Convert base64 string to Blob
          const binaryString = atob(imageData);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: contentType });

          const attachment = new Attachment({
            data: blob,
            filename: filename,
            contentType: contentType,
          });

          return {
            ...input,
            image: attachment,
          };
        } catch (e) {
          console.error("Failed to process input image:", e);
          console.error("Image data sample:", input.image.substring(0, 200));
          return input;
        }
      }

      // Recursively process nested objects
      const result: any = {};
      for (const [key, value] of Object.entries(input)) {
        result[key] = this.processInputImages(value);
      }
      return result;
    }

    return input;
  }

  private processOutputImages(output: any): any {
    if (Array.isArray(output)) {
      return output.map((item) => this.processOutputImages(item));
    }

    if (output && typeof output === "object") {
      // Handle image_generation_call type - convert result to attachment
      if (output.type === "image_generation_call" && output.result) {
        let resultData = output.result;

        // Use output_format from the response
        const fileExtension = output.output_format || "png";
        const contentType = `image/${fileExtension}`;

        // Strip data URI prefix if present (e.g., "data:image/png;base64,")
        const dataUriMatch = resultData.match(/^data:image\/\w+;base64,(.*)$/);
        if (dataUriMatch) {
          resultData = dataUriMatch[1]; // Extract just the base64 part
        }

        const baseFilename =
          output.revised_prompt && typeof output.revised_prompt === "string"
            ? output.revised_prompt.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "_")
            : "generated_image";
        const filename = `${baseFilename}.${fileExtension}`;

        try {
          // Convert base64 string to Blob
          const binaryString = atob(resultData);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: contentType });

          const attachment = new Attachment({
            data: blob,
            filename: filename,
            contentType: contentType,
          });

          return {
            ...output,
            result: attachment,
          };
        } catch (e) {
          console.error("Failed to process output image:", e);
          console.error("Result data sample:", output.result.substring(0, 200));
          return output;
        }
      }

      // Recursively process nested objects
      const result: any = {};
      for (const [key, value] of Object.entries(output)) {
        result[key] = this.processOutputImages(value);
      }
      return result;
    }

    return output;
  }

  private evictOldestTrace(): void {
    if (this.traceOrder.length === 0) return;

    const oldestTraceId = this.traceOrder.shift()!;
    this.traceSpans.delete(oldestTraceId);
  }

  onTraceStart(trace: AgentsTrace): Promise<void> {
    if (this.traceOrder.length >= this.maxTraces) {
      this.evictOldestTrace();
    }

    // Detect parent span from current execution context
    let span: BraintrustSpan;
    const current = currentSpan();

    if (current && current !== NOOP_SPAN) {
      // Create as child of current span
      span = current.startSpan({
        name: trace.name,
        type: SpanTypeAttribute.TASK,
      });
    } else {
      // No parent span available, create as root
      span = this.logger
        ? this.logger.startSpan({
            name: trace.name,
            type: SpanTypeAttribute.TASK,
          })
        : startSpan({
            name: trace.name,
            type: SpanTypeAttribute.TASK,
          });
    }

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

  async onTraceEnd(trace: AgentsTrace): Promise<void> {
    const traceData = this.traceSpans.get(trace.traceId);

    if (traceData) {
      for (const [spanId, braintrustSpan] of traceData.childSpans) {
        braintrustSpan.end();
        traceData.childSpans.delete(spanId);
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
  }

  private extractAgentLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isAgentSpanData(spanData)) {
      return {};
    }

    const data: Record<string, unknown> = {
      metadata: {
        tools: spanData.tools,
        handoffs: spanData.handoffs,
        output_type: spanData.output_type,
      },
    };

    return data;
  }

  private extractResponseLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    const data: Record<string, any> = {};

    if (!isResponseSpanData(spanData)) {
      return data;
    }

    if (spanData._input !== undefined) {
      data.input = this.processInputImages(spanData._input);
    }

    if (spanData._response !== undefined) {
      data.output = this.processOutputImages(spanData._response.output);
    }

    if (spanData._response) {
      const { output, metadata, usage, output_text, ...otherFields } =
        spanData._response;
      data.metadata = otherFields;
    }

    data.metrics = {};
    const ttft = getTimeElapsed(
      span.endedAt ?? undefined,
      span.startedAt ?? undefined,
    );
    if (ttft !== undefined) {
      data.metrics.time_to_first_token = ttft;
    }

    let usage: any = null;
    if (spanData._response?.usage) {
      usage = spanData._response.usage;
    }

    if (usage) {
      if (usage.total_tokens) data.metrics.tokens = usage.total_tokens;
      if (usage.input_tokens) data.metrics.prompt_tokens = usage.input_tokens;
      if (usage.output_tokens)
        data.metrics.completion_tokens = usage.output_tokens;

      if (!data.metrics.tokens && usage.totalTokens)
        data.metrics.tokens = usage.totalTokens;
      if (!data.metrics.prompt_tokens && usage.inputTokens)
        data.metrics.prompt_tokens = usage.inputTokens;
      if (!data.metrics.prompt_tokens && usage.promptTokens)
        data.metrics.prompt_tokens = usage.promptTokens;
      if (!data.metrics.completion_tokens && usage.outputTokens)
        data.metrics.completion_tokens = usage.outputTokens;
      if (!data.metrics.completion_tokens && usage.completionTokens)
        data.metrics.completion_tokens = usage.completionTokens;
      if (usage.input_tokens_details?.cached_tokens != null)
        data.metrics.prompt_cached_tokens =
          usage.input_tokens_details.cached_tokens;
      if (usage.input_tokens_details?.cache_write_tokens != null)
        data.metrics.prompt_cache_creation_tokens =
          usage.input_tokens_details.cache_write_tokens;
    }

    return data;
  }

  private extractFunctionLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isFunctionSpanData(spanData)) {
      return {};
    }

    return {
      input: spanData.input,
      output: spanData.output,
    };
  }

  private extractHandoffLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isHandoffSpanData(spanData)) {
      return {};
    }
    return {
      metadata: {
        from_agent: spanData.from_agent,
        to_agent: spanData.to_agent,
      },
    };
  }

  private extractGuardrailLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isGuardrailSpanData(spanData)) {
      return {};
    }
    return {
      metadata: {
        triggered: spanData.triggered,
      },
    };
  }

  private extractGenerationLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isGenerationSpanData(spanData)) {
      return {};
    }

    const metrics: Record<string, unknown> = {};

    const ttft = getTimeElapsed(
      span.endedAt ?? undefined,
      span.startedAt ?? undefined,
    );
    if (ttft !== undefined) {
      metrics.time_to_first_token = ttft;
    }

    const usage = spanData.usage || {};
    if (usage.prompt_tokens) metrics.prompt_tokens = usage.prompt_tokens;
    else if (usage.input_tokens) metrics.prompt_tokens = usage.input_tokens;

    if (usage.completion_tokens)
      metrics.completion_tokens = usage.completion_tokens;
    else if (usage.output_tokens)
      metrics.completion_tokens = usage.output_tokens;

    if (usage.total_tokens) metrics.tokens = usage.total_tokens;
    else if (usage.input_tokens && usage.output_tokens) {
      metrics.tokens = usage.input_tokens + usage.output_tokens;
    }

    if (usage.input_tokens_details?.cached_tokens != null)
      metrics.prompt_cached_tokens = usage.input_tokens_details.cached_tokens;

    return {
      input: spanData.input,
      output: spanData.output,
      metadata: {
        model: spanData.model,
        model_config: spanData.model_config,
      },
      metrics,
    };
  }

  private extractCustomLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isCustomSpanData(spanData)) {
      return {};
    }
    return spanData.data || {};
  }

  private extractMCPListToolsLogData(
    span: AgentsSpan,
  ): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isMCPListToolsSpanData(spanData)) {
      return {};
    }
    return {
      output: spanData.result,
      metadata: {
        server: spanData.server,
      },
    };
  }

  private extractTranscriptionLogData(
    span: AgentsSpan,
  ): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isTranscriptionSpanData(spanData)) {
      return {};
    }
    return {
      input: spanData.input,
      output: spanData.output,
      metadata: {
        model: spanData.model,
        model_config: spanData.model_config,
      },
    };
  }

  private extractSpeechLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isSpeechSpanData(spanData)) {
      return {};
    }
    return {
      input: spanData.input,
      output: spanData.output,
      metadata: {
        model: spanData.model,
        model_config: spanData.model_config,
      },
    };
  }

  private extractSpeechGroupLogData(span: AgentsSpan): Record<string, unknown> {
    const spanData = span.spanData;
    if (!isSpeechGroupSpanData(spanData)) {
      return {};
    }
    return {
      input: spanData.input,
    };
  }

  private extractLogData(span: AgentsSpan): Record<string, unknown> {
    const spanType = span.spanData?.type;

    switch (spanType) {
      case SpanType.AGENT:
        return this.extractAgentLogData(span);
      case SpanType.RESPONSE:
        return this.extractResponseLogData(span);
      case SpanType.FUNCTION:
        return this.extractFunctionLogData(span);
      case SpanType.HANDOFF:
        return this.extractHandoffLogData(span);
      case SpanType.GUARDRAIL:
        return this.extractGuardrailLogData(span);
      case SpanType.GENERATION:
        return this.extractGenerationLogData(span);
      case SpanType.CUSTOM:
        return this.extractCustomLogData(span);
      case SpanType.MCP_TOOLS:
        return this.extractMCPListToolsLogData(span);
      case SpanType.TRANSCRIPTION:
        return this.extractTranscriptionLogData(span);
      case SpanType.SPEECH:
        return this.extractSpeechLogData(span);
      case SpanType.SPEECH_GROUP:
        return this.extractSpeechGroupLogData(span);
      default:
        return {};
    }
  }

  onSpanStart(span: AgentsSpan): Promise<void> {
    if (!span.spanId || !span.traceId) return Promise.resolve();

    const traceData = this.traceSpans.get(span.traceId);
    if (!traceData) return Promise.resolve();

    let parentSpan: BraintrustSpan | undefined;
    if (span.parentId) {
      parentSpan = traceData.childSpans.get(span.parentId);
    } else {
      parentSpan = traceData.rootSpan;
    }

    if (parentSpan) {
      const childSpan = parentSpan.startSpan({
        name: spanNameFromAgents(span),
        type: spanTypeFromAgents(span),
      });
      traceData.childSpans.set(span.spanId, childSpan);
    }
    return Promise.resolve();
  }

  onSpanEnd(span: AgentsSpan): Promise<void> {
    if (!span.spanId || !span.traceId) return Promise.resolve();

    const traceData = this.traceSpans.get(span.traceId);
    if (!traceData) return Promise.resolve();

    const braintrustSpan = traceData.childSpans.get(span.spanId);

    if (braintrustSpan) {
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
    } else {
      console.warn(`No span found for ID: ${span.spanId}`);
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
}
