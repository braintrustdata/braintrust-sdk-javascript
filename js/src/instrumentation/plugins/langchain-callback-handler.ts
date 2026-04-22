import { currentSpan, initLogger, NOOP_SPAN, startSpan } from "../../logger";
import type { Span } from "../../logger";
import type {
  LangChainCallbackHandlerOptions,
  LangChainEndSpanArgs,
  LangChainLLMResult,
  LangChainSerialized,
  LangChainStartSpanArgs,
} from "../../vendor-sdk-types/langchain";

export const BRAINTRUST_LANGCHAIN_CALLBACK_HANDLER_NAME =
  "BraintrustCallbackHandler";

export class BraintrustLangChainCallbackHandler<
  IsAsyncFlush extends boolean = true,
> {
  name = BRAINTRUST_LANGCHAIN_CALLBACK_HANDLER_NAME;
  private spans = new Map<string, Span>();
  private skippedRuns = new Set<string>();
  private parent?: Span | (() => Span);
  private rootRunId?: string;
  private options: LangChainCallbackHandlerOptions<IsAsyncFlush>;
  private startTimes = new Map<string, number>();
  private firstTokenTimes = new Map<string, number>();
  private ttftMs = new Map<string, number>();

  constructor(
    options?: Partial<LangChainCallbackHandlerOptions<IsAsyncFlush>>,
  ) {
    this.parent = options?.parent;
    this.options = {
      debug: options?.debug ?? false,
      excludeMetadataProps:
        options?.excludeMetadataProps ??
        /^(l[sc]_|langgraph_|__pregel_|checkpoint_ns)/,
      logger: options?.logger,
    };
  }

  protected startSpan({
    runId,
    parentRunId,
    ...args
  }: LangChainStartSpanArgs): void {
    if (this.spans.has(runId)) {
      return;
    }

    if (!parentRunId) {
      this.rootRunId = runId;
    }

    const tags = args.event?.tags;
    const spanAttributes = args.spanAttributes || {};
    spanAttributes.type = args.type || spanAttributes.type || "task";
    args.type = spanAttributes.type;

    const currentParent =
      (typeof this.parent === "function" ? this.parent() : this.parent) ??
      currentSpan();
    let parentSpan: Span;
    if (parentRunId && this.spans.has(parentRunId)) {
      parentSpan = this.spans.get(parentRunId)!;
    } else if (!Object.is(currentParent, NOOP_SPAN)) {
      parentSpan = currentParent;
    } else if (this.options.logger) {
      parentSpan = this.options.logger as unknown as Span;
    } else {
      parentSpan = { startSpan } as unknown as Span;
    }

    args.event = {
      ...args.event,
      tags: undefined,
      metadata: {
        ...(tags ? { tags } : {}),
        ...args.event?.metadata,
        braintrust: {
          integration_name: "langchain-js",
          integration_version: "0.2.0",
          sdk_language: "javascript",
        },
        run_id: runId,
        parent_run_id: parentRunId,
        ...(this.options.debug ? { runId, parentRunId } : {}),
      },
    };

    let span = parentSpan.startSpan(args);

    if (
      !Object.is(this.options.logger, NOOP_SPAN) &&
      Object.is(span, NOOP_SPAN)
    ) {
      span = initLogger().startSpan(args);
    }

    this.spans.set(runId, span);
  }

  protected endSpan({
    runId,
    parentRunId,
    tags,
    metadata,
    ...args
  }: LangChainEndSpanArgs): void {
    if (!this.spans.has(runId)) {
      return;
    }

    if (this.skippedRuns.has(runId)) {
      this.skippedRuns.delete(runId);
      return;
    }

    const span = this.spans.get(runId)!;
    this.spans.delete(runId);
    if (runId === this.rootRunId) {
      this.rootRunId = undefined;
    }

    span.log({ ...args, metadata: { tags, ...metadata } });
    span.end();
  }

  async handleLLMStart(
    llm: LangChainSerialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.startSpan({
      runId,
      parentRunId,
      name: runName ?? getSerializedName(llm) ?? "LLM",
      type: "llm",
      event: {
        input: prompts,
        tags,
        metadata: {
          serialized: llm,
          name: runName,
          metadata,
          ...extraParams,
        },
      },
    });
  }

  async handleLLMError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    this.endSpan({ runId, parentRunId, error: err, tags });
  }

  async handleLLMEnd(
    output: LangChainLLMResult,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    const metrics = getMetricsFromResponse(output);
    const modelName = getModelNameFromResponse(output);
    const ttft = this.ttftMs.get(runId);
    if (ttft !== undefined) {
      metrics.time_to_first_token = ttft;
    }

    this.startTimes.delete(runId);
    this.firstTokenTimes.delete(runId);
    this.ttftMs.delete(runId);

    this.endSpan({
      runId,
      parentRunId,
      output,
      metrics,
      tags,
      metadata: {
        model: modelName,
      },
    });
  }

  async handleChatModelStart(
    llm: LangChainSerialized,
    messages: unknown[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.startTimes.set(runId, Date.now());
    this.firstTokenTimes.delete(runId);
    this.ttftMs.delete(runId);

    this.startSpan({
      runId,
      parentRunId,
      name: runName ?? getSerializedName(llm) ?? "Chat Model",
      type: "llm",
      event: {
        input: messages,
        tags,
        metadata: {
          serialized: llm,
          name: runName,
          metadata,
          ...extraParams,
        },
      },
    });
  }

  async handleChainStart(
    chain: LangChainSerialized,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
  ): Promise<void> {
    if (tags?.includes("langsmith:hidden")) {
      this.skippedRuns.add(runId);
      return;
    }

    this.startSpan({
      runId,
      parentRunId,
      name: runName ?? getSerializedName(chain) ?? "Chain",
      event: {
        input: inputs,
        tags,
        metadata: {
          serialized: chain,
          name: runName,
          metadata,
          run_type: runType,
        },
      },
    });
  }

  async handleChainError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: {
      inputs?: Record<string, unknown>;
    },
  ): Promise<void> {
    this.endSpan({ runId, parentRunId, error: err, tags, metadata: kwargs });
  }

  async handleChainEnd(
    outputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, unknown> },
  ): Promise<void> {
    this.endSpan({
      runId,
      parentRunId,
      tags,
      output: outputs,
      metadata: { ...kwargs },
    });
  }

  async handleToolStart(
    tool: LangChainSerialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.startSpan({
      runId,
      parentRunId,
      name: runName ?? getSerializedName(tool) ?? "Tool",
      type: "llm",
      event: {
        input: safeJsonParse(input),
        tags,
        metadata: {
          metadata,
          serialized: tool,
          input_str: input,
          input: safeJsonParse(input),
          name: runName,
        },
      },
    });
  }

  async handleToolError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    this.endSpan({ runId, parentRunId, error: err, tags });
  }

  async handleToolEnd(
    output: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    this.endSpan({ runId, parentRunId, output, tags });
  }

  async handleAgentAction(
    action: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    this.startSpan({
      runId,
      parentRunId,
      type: "llm",
      name: typeof action.tool === "string" ? action.tool : "Agent",
      event: {
        input: action,
        tags,
      },
    });
  }

  async handleAgentEnd(
    action: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    this.endSpan({ runId, parentRunId, output: action, tags });
  }

  async handleRetrieverStart(
    retriever: LangChainSerialized,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    this.startSpan({
      runId,
      parentRunId,
      name: name ?? getSerializedName(retriever) ?? "Retriever",
      type: "function",
      event: {
        input: query,
        tags,
        metadata: {
          serialized: retriever,
          metadata,
          name,
        },
      },
    });
  }

  async handleRetrieverEnd(
    documents: unknown[],
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    this.endSpan({ runId, parentRunId, output: documents, tags });
  }

  async handleRetrieverError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    this.endSpan({ runId, parentRunId, error: err, tags });
  }

  async handleLLMNewToken(
    _token: string,
    _idx: { prompt: number; completion: number },
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
  ): Promise<void> {
    if (!this.firstTokenTimes.has(runId)) {
      const now = Date.now();
      this.firstTokenTimes.set(runId, now);
      const start = this.startTimes.get(runId);
      if (start !== undefined) {
        this.ttftMs.set(runId, (now - start) / 1000);
      }
    }
  }
}

function getSerializedName(
  serialized: LangChainSerialized,
): string | undefined {
  if (typeof serialized.name === "string") {
    return serialized.name;
  }

  const lastIdPart = serialized.id?.at(-1);
  return typeof lastIdPart === "string" ? lastIdPart : undefined;
}

function cleanObject(obj: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => {
      if (typeof value !== "number") {
        return false;
      }
      return Number.isFinite(value);
    }),
  ) as Record<string, number>;
}

function walkGenerations(
  response: LangChainLLMResult,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const generations = response.generations || [];
  for (const batch of generations) {
    if (Array.isArray(batch)) {
      for (const generation of batch) {
        if (isRecord(generation)) {
          result.push(generation);
        }
      }
    } else if (isRecord(batch)) {
      result.push(batch);
    }
  }
  return result;
}

function getModelNameFromResponse(
  response: LangChainLLMResult,
): string | undefined {
  for (const generation of walkGenerations(response)) {
    const message = generation.message;
    if (!isRecord(message)) {
      continue;
    }

    const responseMetadata = message.response_metadata;
    if (!isRecord(responseMetadata)) {
      continue;
    }

    const modelName = responseMetadata.model_name ?? responseMetadata.model;
    if (typeof modelName === "string") {
      return modelName;
    }
  }

  const llmOutput = response.llmOutput || {};
  const modelName = llmOutput.model_name ?? llmOutput.model;
  return typeof modelName === "string" ? modelName : undefined;
}

function getMetricsFromResponse(
  response: LangChainLLMResult,
): Record<string, number> {
  for (const generation of walkGenerations(response)) {
    const message = generation.message;
    if (!isRecord(message)) {
      continue;
    }

    const usageMetadata = message.usage_metadata;
    if (!isRecord(usageMetadata)) {
      continue;
    }

    const inputTokenDetails = usageMetadata.input_token_details;
    return cleanObject({
      total_tokens: usageMetadata.total_tokens,
      prompt_tokens: usageMetadata.input_tokens,
      completion_tokens: usageMetadata.output_tokens,
      prompt_cache_creation_tokens: isRecord(inputTokenDetails)
        ? inputTokenDetails.cache_creation
        : undefined,
      prompt_cached_tokens: isRecord(inputTokenDetails)
        ? inputTokenDetails.cache_read
        : undefined,
    });
  }

  const llmOutput = response.llmOutput || {};
  const tokenUsage = isRecord(llmOutput.tokenUsage)
    ? llmOutput.tokenUsage
    : isRecord(llmOutput.estimatedTokens)
      ? llmOutput.estimatedTokens
      : {};

  return cleanObject({
    total_tokens: tokenUsage.totalTokens,
    prompt_tokens: tokenUsage.promptTokens,
    completion_tokens: tokenUsage.completionTokens,
  });
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
