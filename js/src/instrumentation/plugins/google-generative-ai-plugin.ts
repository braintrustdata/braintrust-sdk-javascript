import { SpanTypeAttribute } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent, type Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp, isObject } from "../../util";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import type {
  GenerativeAIChat,
  GenerativeAIConfig,
  GenerativeAIContent,
  GenerativeAIEmbedRequest,
  GenerativeAIEmbedResult,
  GenerativeAIMessage,
  GenerativeAIModel,
  GenerativeAIRequest,
  GenerativeAIResponse,
  GenerativeAIResult,
  GenerativeAIStreamResult,
} from "../../vendor-sdk-types/google-generative-ai";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { patchStreamIfNeeded } from "../core/stream-patcher";
import { googleGenerativeAIChannels } from "./google-generative-ai-channels";

const GENERATION_CONFIG_KEYS = [
  "temperature",
  "topP",
  "topK",
  "candidateCount",
  "maxOutputTokens",
  "stopSequences",
  "responseMimeType",
  "responseSchema",
  "presencePenalty",
  "frequencyPenalty",
  "responseLogprobs",
  "logprobs",
  "thinkingConfig",
] as const;

type Result =
  | GenerativeAIResult
  | GenerativeAIStreamResult
  | GenerativeAIEmbedResult;
type Request =
  | GenerativeAIMessage
  | GenerativeAIRequest
  | GenerativeAIEmbedRequest
  | { requests: GenerativeAIEmbedRequest[] };
type Operation = keyof typeof googleGenerativeAIChannels;

type GenerativeAIChannel<TArgs extends unknown[], TResult> = {
  intercept(
    interceptor: (
      target: (this: unknown, ...args: TArgs) => PromiseLike<TResult>,
      thisArg: unknown,
      args: TArgs,
    ) => PromiseLike<TResult>,
  ): () => void;
};

export class GoogleGenerativeAIPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      interceptCall(
        googleGenerativeAIChannels.generateContent,
        "generateContent",
      ),
      interceptCall(
        googleGenerativeAIChannels.generateContentStream,
        "generateContentStream",
      ),
      interceptCall(googleGenerativeAIChannels.sendMessage, "sendMessage"),
      interceptCall(
        googleGenerativeAIChannels.sendMessageStream,
        "sendMessageStream",
      ),
      interceptCall(googleGenerativeAIChannels.embedContent, "embedContent"),
      interceptCall(
        googleGenerativeAIChannels.batchEmbedContents,
        "batchEmbedContents",
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function interceptCall<
  TArgs extends [Request, unknown?],
  TResult extends Result,
>(
  channel: GenerativeAIChannel<TArgs, TResult>,
  operation: Operation,
): () => void {
  return channel.intercept((target, thisArg, args) => {
    const invokeTarget = () => Reflect.apply(target, thisArg, args);
    if (isAutoInstrumentationSuppressed()) return invokeTarget();
    const self = thisArg as GenerativeAIModel | GenerativeAIChat;
    const chat = operation.startsWith("sendMessage");
    const embedding =
      operation === "embedContent" || operation === "batchEmbedContents";
    const start = getCurrentUnixTimestamp();
    let span: Span;
    try {
      span = startSpan(
        withSpanInstrumentationName(
          {
            name: embedding
              ? operation === "embedContent"
                ? "embed_content"
                : "batch_embed_contents"
              : "generate_content",
            spanAttributes: { type: SpanTypeAttribute.LLM },
            event: extractInput(self, args[0], operation),
          },
          INSTRUMENTATION_NAMES.GOOGLE_GENERATIVE_AI,
        ),
      );
    } catch (error) {
      debugLogger.error("Error starting Google Generative AI span:", error);
      return invokeTarget();
    }
    let ended = false;
    const finish = (log: () => void) => {
      if (ended) return;
      ended = true;
      try {
        log();
      } catch (error) {
        debugLogger.error("Error logging Google Generative AI span:", error);
      }
      try {
        span.end();
      } catch (error) {
        debugLogger.error("Error ending Google Generative AI span:", error);
      }
    };
    // The SDK serializes chat sends on this promise. Capture history after the
    // preceding send completes, before the current SDK call appends its turn.
    if (chat) {
      try {
        void (self as GenerativeAIChat)._sendPromise.then(
          () => {
            try {
              span.log(extractInput(self, args[0], operation));
            } catch (error) {
              debugLogger.error("Error capturing Google chat history:", error);
            }
          },
          () => {},
        );
      } catch (error) {
        debugLogger.error("Error observing Google chat history:", error);
      }
    }
    let result: PromiseLike<TResult>;
    try {
      result = withCurrent(span, () =>
        runWithAutoInstrumentationSuppressed(invokeTarget),
      );
    } catch (error) {
      finish(() => span.log({ error }));
      throw error;
    }
    void Promise.resolve(result).then(
      (value) => {
        try {
          if ("stream" in value) {
            let firstToken = false;
            const partial: GenerativeAIResponse = { candidates: [] };
            const candidates = new Map<
              number,
              NonNullable<GenerativeAIResponse["candidates"]>[number]
            >();
            patchStreamIfNeeded<GenerativeAIResponse>(value.stream, {
              aroundNext: (callback) => withCurrent(span, callback),
              onChunk: (chunk) => {
                for (const candidate of chunk.candidates ?? []) {
                  const index = candidate.index ?? 0;
                  const previous = candidates.get(index);
                  const parts = [...(previous?.content?.parts ?? [])];
                  for (const part of candidate.content?.parts ?? []) {
                    const last = parts[parts.length - 1];
                    if (part.text !== undefined && last?.text !== undefined) {
                      parts[parts.length - 1] = {
                        ...last,
                        text: last.text + part.text,
                      };
                    } else parts.push(part);
                  }
                  candidates.set(index, {
                    ...previous,
                    ...candidate,
                    content: {
                      role:
                        candidate.content?.role ??
                        previous?.content?.role ??
                        "model",
                      parts,
                    },
                  });
                }
                partial.candidates = Array.from(candidates.values());
                if (chunk.usageMetadata)
                  partial.usageMetadata = chunk.usageMetadata;
                if (
                  !firstToken &&
                  chunk.candidates?.some((candidate) =>
                    candidate.content?.parts.some((part) =>
                      part.text !== undefined
                        ? part.text.length > 0
                        : Object.keys(part).length > 0,
                    ),
                  )
                ) {
                  firstToken = true;
                  span.log({
                    metrics: {
                      time_to_first_token: getCurrentUnixTimestamp() - start,
                    },
                  });
                }
              },
              onComplete: () => {},
              onError: (error) =>
                finish(() => {
                  logResponse(span, partial);
                  span.log({ error });
                }),
              onCancel: () => finish(() => logResponse(span, partial)),
            });
            // The SDK tees its stream to build this aggregate, even when callers
            // only await response. Observe it without replacing either public value.
            void value.response.then(
              (response) => finish(() => logResponse(span, response)),
              (error) =>
                finish(() => {
                  logResponse(span, partial);
                  span.log({ error });
                }),
            );
          } else if ("response" in value) {
            finish(() => logResponse(span, value.response));
          } else {
            const metrics: Record<string, number> = {};
            const promptTokens = value.usageMetadata?.promptTokenCount;
            if (
              typeof promptTokens === "number" &&
              Number.isFinite(promptTokens) &&
              promptTokens >= 0
            ) {
              metrics.prompt_tokens = promptTokens;
              metrics.tokens = promptTokens;
            }
            for (const detail of value.usageMetadata?.promptTokenDetails ??
              []) {
              if (
                detail.modality === "AUDIO" &&
                typeof detail.tokenCount === "number" &&
                Number.isFinite(detail.tokenCount) &&
                detail.tokenCount >= 0
              ) {
                metrics.prompt_audio_tokens =
                  (metrics.prompt_audio_tokens ?? 0) + detail.tokenCount;
              }
            }
            finish(() =>
              span.log({
                metrics,
                output: {
                  count: value.embeddings?.length ?? (value.embedding ? 1 : 0),
                },
              }),
            );
          }
        } catch (error) {
          debugLogger.error(
            "Error observing Google Generative AI result:",
            error,
          );
          finish(() => {});
        }
      },
      (error) => finish(() => span.log({ error })),
    );
    return result;
  });
}

function normalizeContent(message: GenerativeAIMessage): GenerativeAIContent {
  const parts = (typeof message === "string" ? [message] : message).map(
    (part) => (typeof part === "string" ? { text: part } : part),
  );
  return {
    role: parts.some((part) => part.functionResponse) ? "function" : "user",
    parts,
  };
}

function extractInput(
  self: GenerativeAIModel | GenerativeAIChat,
  request: Request,
  operation: Operation,
) {
  const model = self.model.replace(/^models\//, "");
  if (operation === "embedContent" || operation === "batchEmbedContents") {
    const requests =
      operation === "batchEmbedContents"
        ? (request as { requests: GenerativeAIEmbedRequest[] }).requests
        : [
            typeof request === "string" || Array.isArray(request)
              ? { content: normalizeContent(request) }
              : (request as GenerativeAIEmbedRequest),
          ];
    const dimensions = requests[0]?.outputDimensionality;
    return {
      input: {
        inputs: convertAttachments(requests).map((item) => ({
          content:
            item.content.parts.length === 1 &&
            item.content.parts[0].text !== undefined
              ? item.content.parts[0].text
              : item.content.parts.map((part) => {
                  if (part.text !== undefined)
                    return { type: "text", text: part.text };
                  const mimeType =
                    part.inlineData?.mimeType ?? part.fileData?.mimeType;
                  const data = part.inlineData
                    ? typeof part.inlineData.data === "string"
                      ? `data:${mimeType};base64,${part.inlineData.data}`
                      : part.inlineData.data
                    : part.fileData?.fileUri;
                  return mimeType?.startsWith("image/")
                    ? { type: "image_url", image_url: { url: data } }
                    : { type: "file", file: { file_data: data } };
                }),
        })),
        ...(dimensions !== undefined &&
        requests.every((item) => item.outputDimensionality === dimensions)
          ? { output_dimensions: dimensions }
          : {}),
      },
      metadata: { model, provider: "google" },
    };
  }
  const chat = operation.startsWith("sendMessage");
  const config: GenerativeAIConfig = chat
    ? ((self as GenerativeAIChat).params ?? {})
    : (self as GenerativeAIModel);
  const params: GenerativeAIRequest =
    typeof request === "string" || Array.isArray(request)
      ? { contents: [normalizeContent(request)] }
      : (request as GenerativeAIRequest);
  const system = params.systemInstruction ?? config.systemInstruction;
  const systemContent =
    typeof system === "string"
      ? { role: "system", parts: [{ text: system }] }
      : system && "parts" in system
        ? { ...system, role: "system" }
        : system
          ? { role: "system", parts: [system] }
          : undefined;
  const contents = [
    ...(systemContent ? [systemContent] : []),
    ...(chat ? (self as GenerativeAIChat)._history : []),
    ...params.contents,
  ];
  const metadata: Record<string, unknown> = { model, provider: "google" };
  const generation = params.generationConfig ?? config.generationConfig;
  for (const key of GENERATION_CONFIG_KEYS) {
    if (generation && Object.hasOwn(generation, key))
      metadata[key] = generation[key];
  }
  for (const key of ["tools", "toolConfig", "safetySettings"] as const) {
    const value = params[key] ?? config[key];
    if (value !== undefined) metadata[key] = value;
  }
  const cached = params.cachedContent ?? config.cachedContent;
  if (cached)
    metadata.cachedContent = typeof cached === "string" ? cached : cached.name;
  return { input: convertAttachments({ model, contents }), metadata };
}

// Convert Google's inlineData to the shared attachment processor's file shape,
// then restore the native payload shape. Any conversion failure keeps all input.
function convertAttachments<T>(value: T): T {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (!isObject(node)) return node;
    if (isObject(node.inlineData)) {
      const { data, mimeType } = node.inlineData;
      const processed = processInputAttachments({
        type: "file",
        file: { file_data: `data:${mimeType};base64,${data}` },
      });
      if (typeof processed.file.file_data === "string")
        throw new Error("Unable to convert Google inline data");
      return {
        ...node,
        inlineData: { ...node.inlineData, data: processed.file.file_data },
      };
    }
    return Object.fromEntries(
      Object.entries(node).map(([key, item]) => [key, convert(item)]),
    );
  };
  try {
    return convert(value) as T;
  } catch (error) {
    debugLogger.error(
      "Error converting Google Generative AI attachments:",
      error,
    );
    return value;
  }
}

function logResponse(span: Span, response: GenerativeAIResponse): void {
  const usage = response.usageMetadata;
  const metrics: Record<string, number> = {};
  if (usage) {
    if (usage.promptTokenCount !== undefined)
      metrics.prompt_tokens = usage.promptTokenCount;
    if (
      usage.candidatesTokenCount !== undefined ||
      usage.thoughtsTokenCount !== undefined
    )
      metrics.completion_tokens =
        (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    if (usage.totalTokenCount !== undefined)
      metrics.tokens = usage.totalTokenCount;
    if (usage.cachedContentTokenCount !== undefined)
      metrics.prompt_cached_tokens = usage.cachedContentTokenCount;
    if (usage.thoughtsTokenCount !== undefined)
      metrics.completion_reasoning_tokens = usage.thoughtsTokenCount;
  }
  span.log({
    output: convertAttachments({
      candidates: response.candidates,
      promptFeedback: response.promptFeedback,
    }),
    metrics,
    ...(response.modelVersion
      ? { metadata: { model: response.modelVersion } }
      : {}),
  });
}
