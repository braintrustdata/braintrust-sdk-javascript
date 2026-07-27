import { SpanTypeAttribute, isObject } from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import type {
  VoyageAIContextualizedResult,
  VoyageAIEmbeddingResponse,
  VoyageAIRerankResponse,
  VoyageAIUsage,
} from "../../vendor-sdk-types/voyageai";
import { BasePlugin } from "../core";
import { traceAsyncChannel, unsubscribeAll } from "../core/channel-tracing";
import { voyageAIChannels } from "./voyageai-channels";

const EMBED_METADATA_ALLOWLIST = new Set([
  "encodingFormat",
  "inputType",
  "model",
  "outputDimension",
  "outputDtype",
  "truncation",
]);

const MULTIMODAL_EMBED_METADATA_ALLOWLIST = new Set([
  "encodingFormat",
  "inputType",
  "model",
  "truncation",
]);

const RERANK_METADATA_ALLOWLIST = new Set([
  "model",
  "returnDocuments",
  "topK",
  "truncation",
]);

const CONTEXTUALIZED_EMBED_METADATA_ALLOWLIST = new Set([
  "inputType",
  "model",
  "outputDimension",
  "outputDtype",
]);

export class VoyageAIPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceAsyncChannel(voyageAIChannels.embed, {
        name: "voyageai.embed",
        type: SpanTypeAttribute.LLM,
        extractInput: (args) =>
          extractEmbeddingInput(args, "input", EMBED_METADATA_ALLOWLIST),
        extractOutput: summarizeEmbeddingOutput,
        extractMetadata: extractResponseMetadata,
        extractMetrics: extractUsageMetrics,
      }),
      traceAsyncChannel(voyageAIChannels.multimodalEmbed, {
        name: "voyageai.multimodalEmbed",
        type: SpanTypeAttribute.LLM,
        extractInput: (args) =>
          extractEmbeddingInput(
            args,
            "inputs",
            MULTIMODAL_EMBED_METADATA_ALLOWLIST,
            true,
          ),
        extractOutput: summarizeEmbeddingOutput,
        extractMetadata: extractResponseMetadata,
        extractMetrics: extractUsageMetrics,
      }),
      traceAsyncChannel(voyageAIChannels.rerank, {
        name: "voyageai.rerank",
        type: SpanTypeAttribute.LLM,
        extractInput: extractRerankInput,
        extractOutput: summarizeRerankOutput,
        extractMetadata: extractResponseMetadata,
        extractMetrics: extractUsageMetrics,
      }),
      traceAsyncChannel(voyageAIChannels.contextualizedEmbed, {
        name: "voyageai.contextualizedEmbed",
        type: SpanTypeAttribute.LLM,
        extractInput: (args) =>
          extractEmbeddingInput(
            args,
            "inputs",
            CONTEXTUALIZED_EMBED_METADATA_ALLOWLIST,
          ),
        extractOutput: summarizeContextualizedEmbeddingOutput,
        extractMetadata: extractResponseMetadata,
        extractMetrics: extractUsageMetrics,
      }),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
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

function extractEmbeddingInput(
  args: unknown,
  inputKey: "input" | "inputs",
  metadataAllowlist: ReadonlySet<string>,
  processAttachments = false,
): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const request = getRequestArg(args);
  const input = request?.[inputKey];

  return {
    input: processAttachments ? processInputAttachments(input) : input,
    metadata: pickMetadata(request, metadataAllowlist),
  };
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
  result: VoyageAIEmbeddingResponse | VoyageAIRerankResponse,
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

function summarizeEmbeddingOutput(
  result: VoyageAIEmbeddingResponse,
): Record<string, number> | undefined {
  if (!isObject(result) || !Array.isArray(result.data)) {
    return undefined;
  }

  const firstEmbedding =
    isObject(result.data[0]) && Array.isArray(result.data[0].embedding)
      ? result.data[0].embedding
      : undefined;

  return {
    embedding_count: result.data.length,
    ...(firstEmbedding ? { embedding_length: firstEmbedding.length } : {}),
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
): Record<string, number> | undefined {
  if (!isObject(result)) {
    return undefined;
  }

  if (Array.isArray(result.results)) {
    const embeddings = result.results.flatMap((item) =>
      isObject(item) && Array.isArray(item.embeddings) ? item.embeddings : [],
    );
    const firstEmbedding = Array.isArray(embeddings[0])
      ? embeddings[0]
      : undefined;

    return {
      document_count: result.results.length,
      embedding_count: embeddings.length,
      ...(firstEmbedding ? { embedding_length: firstEmbedding.length } : {}),
    };
  }

  if (!Array.isArray(result.data)) {
    return undefined;
  }

  const embeddings = result.data.flatMap((item) =>
    isObject(item) && Array.isArray(item.data) ? item.data : [],
  );
  const firstEmbedding =
    isObject(embeddings[0]) && Array.isArray(embeddings[0].embedding)
      ? embeddings[0].embedding
      : undefined;

  return {
    document_count: result.data.length,
    embedding_count: embeddings.length,
    ...(firstEmbedding ? { embedding_length: firstEmbedding.length } : {}),
  };
}

function extractUsageMetrics(
  result:
    | VoyageAIEmbeddingResponse
    | VoyageAIRerankResponse
    | VoyageAIContextualizedResult,
): Record<string, number> {
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
