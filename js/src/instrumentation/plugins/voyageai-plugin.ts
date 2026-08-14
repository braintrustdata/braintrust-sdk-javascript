import { SpanTypeAttribute, isObject } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent } from "../../logger";
import type { Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import type {
  VoyageAIContextualizedResult,
  VoyageAIEmbeddingResponse,
  VoyageAIRerankResponse,
  VoyageAIUsage,
} from "../../vendor-sdk-types/voyageai";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { voyageAIChannels } from "./voyageai-channels";

const RERANK_METADATA_ALLOWLIST = new Set([
  "model",
  "returnDocuments",
  "topK",
  "truncation",
]);

export class VoyageAIPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      interceptVoyageAICall(
        voyageAIChannels.embed,
        "voyageai.embed",
        extractTextEmbeddingInput,
        summarizeEmbeddingOutput,
        extractEmbeddingUsageMetrics,
      ),
      interceptVoyageAICall(
        voyageAIChannels.multimodalEmbed,
        "voyageai.multimodalEmbed",
        extractMultimodalEmbeddingInput,
        summarizeEmbeddingOutput,
        extractEmbeddingUsageMetrics,
      ),
      interceptVoyageAICall(
        voyageAIChannels.rerank,
        "voyageai.rerank",
        extractRerankInput,
        summarizeRerankOutput,
      ),
      interceptVoyageAICall(
        voyageAIChannels.contextualizedEmbed,
        "voyageai.contextualizedEmbed",
        extractContextualizedEmbeddingInput,
        summarizeContextualizedEmbeddingOutput,
        extractEmbeddingUsageMetrics,
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

type VoyageAIResult =
  | VoyageAIEmbeddingResponse
  | VoyageAIRerankResponse
  | VoyageAIContextualizedResult;

type VoyageAIChannel<TArgs extends unknown[], TResult> = {
  intercept(
    interceptor: (
      target: (this: unknown, ...args: TArgs) => PromiseLike<TResult>,
      thisArg: unknown,
      args: TArgs,
    ) => PromiseLike<TResult>,
  ): () => void;
};

function interceptVoyageAICall<
  TArgs extends unknown[],
  TResult extends VoyageAIResult,
>(
  channel: VoyageAIChannel<TArgs, TResult>,
  name: string,
  extractInput: (args: TArgs) => {
    input: unknown;
    metadata: Record<string, unknown>;
  },
  extractOutput: (result: TResult) => unknown,
  extractMetrics: (
    result: TResult,
  ) => Record<string, number> = extractUsageMetrics,
): () => void {
  return channel.intercept((target, thisArg, args) => {
    const invokeTarget = () => Reflect.apply(target, thisArg, args);
    if (isAutoInstrumentationSuppressed()) {
      return invokeTarget();
    }

    let span: Span;
    try {
      const { input, metadata } = extractInput(args);
      span = startSpan(
        withSpanInstrumentationName(
          {
            event: { input, metadata },
            name,
            spanAttributes: { type: SpanTypeAttribute.LLM },
          },
          INSTRUMENTATION_NAMES.VOYAGEAI,
        ),
      );
    } catch (error) {
      debugLogger.error(`Error starting span for ${name}:`, error);
      return invokeTarget();
    }

    let result: PromiseLike<TResult>;
    try {
      result = withCurrent(span, () =>
        runWithAutoInstrumentationSuppressed(invokeTarget),
      );
    } catch (error) {
      finishVoyageAISpan(span, name, () => span.log({ error }));
      throw error;
    }

    void Promise.resolve(result).then(
      (value) =>
        finishVoyageAISpan(span, name, () => {
          const metadata = extractResponseMetadata(value);
          span.log({
            output: extractOutput(value),
            ...(metadata ? { metadata } : {}),
            metrics: extractMetrics(value),
          });
        }),
      (error) => finishVoyageAISpan(span, name, () => span.log({ error })),
    );
    return result;
  });
}

function finishVoyageAISpan(span: Span, name: string, log: () => void): void {
  try {
    log();
  } catch (error) {
    debugLogger.error(`Error logging span for ${name}:`, error);
  }
  try {
    span.end();
  } catch (error) {
    debugLogger.error(`Error ending span for ${name}:`, error);
  }
}

function getRequestArg(args: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(args)) {
    return isObject(args[0]) ? args[0] : undefined;
  }

  if (!isObject(args)) {
    return undefined;
  }

  const firstArg = Reflect.get(args, "0");
  return isObject(firstArg) ? firstArg : undefined;
}

function pickMetadata(
  request: Record<string, unknown> | undefined,
  allowlist: ReadonlySet<string>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (request) {
    for (const key of allowlist) {
      if (!Object.hasOwn(request, key)) {
        continue;
      }
      const value = request[key];
      if (value !== undefined) {
        metadata[key] = value;
      }
    }
  }

  return {
    ...metadata,
    provider: "voyage",
  };
}

type EmbeddingContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: unknown } }
  | { type: "file"; file: { file_data: unknown } };

type EmbeddingInput = {
  inputs: Array<{ content: string | EmbeddingContentPart[] }>;
  output_dimensions?: number;
};

function buildEmbeddingInput(
  inputs: EmbeddingInput["inputs"],
  request: Record<string, unknown> | undefined,
): EmbeddingInput {
  const outputDimensions = request?.outputDimension;
  return {
    inputs,
    ...(typeof outputDimensions === "number" &&
    Number.isFinite(outputDimensions)
      ? { output_dimensions: outputDimensions }
      : {}),
  };
}

function embeddingMetadata(
  request: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(typeof request?.model === "string" ? { model: request.model } : {}),
    provider: "voyage",
  };
}

function extractTextEmbeddingInput(args: unknown): {
  input: EmbeddingInput;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const rawInput = request?.input;
  const values = Array.isArray(rawInput) ? rawInput : [rawInput];

  return {
    input: buildEmbeddingInput(
      values.flatMap((value) =>
        typeof value === "string" ? [{ content: value }] : [],
      ),
      request,
    ),
    metadata: embeddingMetadata(request),
  };
}

function extractContextualizedEmbeddingInput(args: unknown): {
  input: EmbeddingInput;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const rawInputs = request?.inputs;
  const values = Array.isArray(rawInputs)
    ? rawInputs.flatMap((value) => (Array.isArray(value) ? value : [value]))
    : [];

  return {
    input: buildEmbeddingInput(
      values.flatMap((value) =>
        typeof value === "string" ? [{ content: value }] : [],
      ),
      request,
    ),
    metadata: embeddingMetadata(request),
  };
}

function extractMultimodalEmbeddingInput(args: unknown): {
  input: EmbeddingInput;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const rawInputs = request?.inputs;
  const inputs = Array.isArray(rawInputs)
    ? rawInputs.map((rawInput) => {
        const rawContent = isObject(rawInput) ? rawInput.content : undefined;
        return {
          content: Array.isArray(rawContent)
            ? rawContent.flatMap(normalizeMultimodalContentPart)
            : [],
        };
      })
    : [];
  const input = buildEmbeddingInput(inputs, request);
  const processedInput = processInputAttachments(input);

  return {
    input: hasInlineEmbeddingMedia(processedInput) ? input : processedInput,
    metadata: embeddingMetadata(request),
  };
}

function normalizeMultimodalContentPart(part: unknown): EmbeddingContentPart[] {
  if (!isObject(part) || typeof part.type !== "string") {
    return [];
  }
  if (part.type === "text") {
    return typeof part.text === "string"
      ? [{ type: "text", text: part.text }]
      : [];
  }

  const camelCaseField: Record<string, string> = {
    image_base64: "imageBase64",
    image_url: "imageUrl",
    video_base64: "videoBase64",
    video_url: "videoUrl",
  };
  const field = camelCaseField[part.type];
  if (!field) {
    return [];
  }
  const data = typeof part[field] === "string" ? part[field] : part[part.type];
  if (typeof data !== "string") {
    return [];
  }

  return part.type.startsWith("image_")
    ? [{ type: "image_url", image_url: { url: data } }]
    : [{ type: "file", file: { file_data: data } }];
}

function hasInlineEmbeddingMedia(input: EmbeddingInput): boolean {
  return input.inputs.some(({ content }) =>
    Array.isArray(content)
      ? content.some((part) => {
          const value =
            part.type === "image_url"
              ? part.image_url.url
              : part.type === "file"
                ? part.file.file_data
                : undefined;
          return typeof value === "string" && value.startsWith("data:");
        })
      : false,
  );
}

function extractRerankInput(args: unknown): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const documents = request?.documents;

  return {
    input: {
      documents,
      query: request?.query,
    },
    metadata: {
      ...pickMetadata(request, RERANK_METADATA_ALLOWLIST),
      ...(Array.isArray(documents) ? { document_count: documents.length } : {}),
    },
  };
}

function extractResponseMetadata(
  result: VoyageAIResult,
): Record<string, unknown> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  const rawResponse = isObject(result.rawResponse)
    ? result.rawResponse
    : undefined;
  const model =
    typeof result.model === "string"
      ? result.model
      : typeof rawResponse?.model === "string"
        ? rawResponse.model
        : undefined;

  return model ? { model } : undefined;
}

function summarizeEmbeddingOutput(result: VoyageAIEmbeddingResponse): {
  count: number;
} {
  return {
    count:
      isObject(result) && Array.isArray(result.data) ? result.data.length : 0,
  };
}

function summarizeRerankOutput(
  result: VoyageAIRerankResponse,
): unknown[] | undefined {
  if (!isObject(result) || !Array.isArray(result.data)) {
    return undefined;
  }

  return result.data.slice(0, 100).map((item) => ({
    index: isObject(item) ? item.index : undefined,
    relevance_score: isObject(item)
      ? ((typeof item.relevanceScore === "number"
          ? item.relevanceScore
          : item.relevance_score) ?? null)
      : null,
  }));
}

function summarizeContextualizedEmbeddingOutput(
  result: VoyageAIContextualizedResult,
): { count: number } {
  if (!isObject(result)) {
    return { count: 0 };
  }

  if (Array.isArray(result.results)) {
    return {
      count: result.results.reduce(
        (count, item) =>
          count +
          (isObject(item) && Array.isArray(item.embeddings)
            ? item.embeddings.length
            : 0),
        0,
      ),
    };
  }

  if (!Array.isArray(result.data)) {
    return { count: 0 };
  }

  return {
    count: result.data.reduce(
      (count, item) =>
        count +
        (isObject(item) && Array.isArray(item.data) ? item.data.length : 0),
      0,
    ),
  };
}

function extractEmbeddingUsageMetrics(
  result: VoyageAIResult,
): Record<string, number> {
  const metrics = extractUsageMetrics(result);
  return typeof metrics.tokens === "number"
    ? { prompt_tokens: metrics.tokens, tokens: metrics.tokens }
    : {};
}

function extractUsageMetrics(result: VoyageAIResult): Record<string, number> {
  if (!isObject(result)) {
    return {};
  }

  const rawResponse = isObject(result.rawResponse)
    ? result.rawResponse
    : undefined;
  const usage = (
    isObject(result.usage)
      ? result.usage
      : isObject(rawResponse?.usage)
        ? rawResponse.usage
        : undefined
  ) as VoyageAIUsage | undefined;
  const tokens =
    typeof result.totalTokens === "number"
      ? result.totalTokens
      : (usage?.totalTokens ?? usage?.total_tokens);

  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
    ? { tokens }
    : {};
}
