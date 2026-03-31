import { BasePlugin } from "../core";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import { SpanTypeAttribute } from "../../../util/index";
import { getCurrentUnixTimestamp } from "../../util";
import { Attachment, type Span, withCurrent } from "../../logger";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
} from "../../wrappers/attachment-utils";
import { normalizeAISDKLoggedOutput } from "../../wrappers/ai-sdk/normalize-logged-output";
import { serializeAISDKToolsForLogging } from "../../wrappers/ai-sdk/tool-serialization";
import { zodToJsonSchema } from "../../zod/utils";
import { aiSDKChannels } from "./ai-sdk-channels";
import type {
  AISDK,
  AISDKCallParams,
  AISDKLanguageModel,
  AISDKModel,
  AISDKModelStreamChunk,
  AISDKOutputObject,
  AISDKOutputResponseFormat,
  AISDKResult,
  AISDKTool,
  AISDKTools,
  AISDKUsage,
} from "../../vendor-sdk-types/ai-sdk";

export interface AISDKPluginConfig {
  /**
   * List of JSON paths to remove from output field.
   * Uses dot notation with array wildcards: "roundtrips[].request.body"
   */
  denyOutputPaths?: string[];
}

/**
 * Default paths to omit from AI SDK output logging.
 * These contain redundant or verbose data that's not useful for tracing.
 */
const DEFAULT_DENY_OUTPUT_PATHS: string[] = [
  // v3
  "roundtrips[].request.body",
  "roundtrips[].response.headers",
  "rawResponse.headers",
  "responseMessages",
  // v5
  "request.body",
  "response.body",
  "response.headers",
  "steps[].request.body",
  "steps[].response.body",
  "steps[].response.headers",
];

const AUTO_PATCHED_MODEL = Symbol.for("braintrust.ai-sdk.auto-patched-model");
const AUTO_PATCHED_TOOL = Symbol.for("braintrust.ai-sdk.auto-patched-tool");
const RUNTIME_DENY_OUTPUT_PATHS = Symbol.for(
  "braintrust.ai-sdk.deny-output-paths",
);

/**
 * AI SDK plugin that subscribes to instrumentation channels
 * and creates Braintrust spans.
 *
 * This plugin handles:
 * - generateText (async function)
 * - streamText (function returning stream)
 * - generateObject (async function)
 * - streamObject (function returning stream)
 * - Agent.generate (async method)
 * - Agent.stream (async method returning stream)
 * - ToolLoopAgent.generate (async method)
 * - ToolLoopAgent.stream (async method returning stream)
 *
 * The plugin automatically extracts:
 * - Model and provider information
 * - Token usage metrics
 * - Tool calls and structured outputs
 * - Streaming responses with time-to-first-token
 */
export class AISDKPlugin extends BasePlugin {
  private config: AISDKPluginConfig;

  constructor(config: AISDKPluginConfig = {}) {
    super();
    this.config = config;
  }

  protected onEnable(): void {
    this.subscribeToAISDK();
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }

  private subscribeToAISDK(): void {
    const denyOutputPaths =
      this.config.denyOutputPaths || DEFAULT_DENY_OUTPUT_PATHS;

    // generateText - async function that may return streams
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.generateText, {
        name: "generateText",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) => {
          finalizeAISDKChildTracing(endEvent as { [key: string]: unknown });
          return processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          );
        },
        extractMetrics: (result, _startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent),
        aggregateChunks: aggregateAISDKChunks,
      }),
    );

    // streamText - function returning stream
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.streamText, {
        name: "streamText",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) =>
          processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          ),
        extractMetrics: (result, startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent, startTime),
        aggregateChunks: aggregateAISDKChunks,
        patchResult: ({ endEvent, result, span, startTime }) =>
          patchAISDKStreamingResult({
            defaultDenyOutputPaths: denyOutputPaths,
            endEvent,
            result,
            span,
            startTime,
          }),
      }),
    );

    // generateObject - async function that may return streams
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.generateObject, {
        name: "generateObject",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) => {
          finalizeAISDKChildTracing(endEvent as { [key: string]: unknown });
          return processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          );
        },
        extractMetrics: (result, _startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent),
        aggregateChunks: aggregateAISDKChunks,
      }),
    );

    // streamObject - function returning stream
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.streamObject, {
        name: "streamObject",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) =>
          processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          ),
        extractMetrics: (result, startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent, startTime),
        aggregateChunks: aggregateAISDKChunks,
        patchResult: ({ endEvent, result, span, startTime }) =>
          patchAISDKStreamingResult({
            defaultDenyOutputPaths: denyOutputPaths,
            endEvent,
            result,
            span,
            startTime,
          }),
      }),
    );

    // Agent.generate - async method
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.agentGenerate, {
        name: "Agent.generate",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) => {
          finalizeAISDKChildTracing(endEvent as { [key: string]: unknown });
          return processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          );
        },
        extractMetrics: (result, _startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent),
        aggregateChunks: aggregateAISDKChunks,
      }),
    );

    // Agent.stream - async method returning stream
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.agentStream, {
        name: "Agent.stream",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) =>
          processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          ),
        extractMetrics: (result, startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent, startTime),
        aggregateChunks: aggregateAISDKChunks,
        patchResult: ({ endEvent, result, span, startTime }) =>
          patchAISDKStreamingResult({
            defaultDenyOutputPaths: denyOutputPaths,
            endEvent,
            result,
            span,
            startTime,
          }),
      }),
    );

    // ToolLoopAgent.generate - async method
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.toolLoopAgentGenerate, {
        name: "ToolLoopAgent.generate",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) => {
          finalizeAISDKChildTracing(endEvent as { [key: string]: unknown });
          return processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          );
        },
        extractMetrics: (result, _startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent),
        aggregateChunks: aggregateAISDKChunks,
      }),
    );

    // ToolLoopAgent.stream - async method returning stream
    this.unsubscribers.push(
      traceStreamingChannel(aiSDKChannels.toolLoopAgentStream, {
        name: "ToolLoopAgent.stream",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params], event, span) =>
          prepareAISDKInput(params, event, span, denyOutputPaths),
        extractOutput: (result, endEvent) =>
          processAISDKOutput(
            result,
            resolveDenyOutputPaths(endEvent, denyOutputPaths),
          ),
        extractMetrics: (result, startTime, endEvent) =>
          extractTopLevelAISDKMetrics(result, endEvent, startTime),
        aggregateChunks: aggregateAISDKChunks,
        patchResult: ({ endEvent, result, span, startTime }) =>
          patchAISDKStreamingResult({
            defaultDenyOutputPaths: denyOutputPaths,
            endEvent,
            result,
            span,
            startTime,
          }),
      }),
    );
  }
}

function resolveDenyOutputPaths(
  event:
    | {
        arguments?: ArrayLike<unknown>;
        denyOutputPaths?: string[];
      }
    | undefined,
  defaultDenyOutputPaths: string[],
): string[] {
  if (Array.isArray(event?.denyOutputPaths)) {
    return event.denyOutputPaths;
  }

  const firstArgument =
    event?.arguments && event.arguments.length > 0
      ? event.arguments[0]
      : undefined;
  if (!firstArgument || typeof firstArgument !== "object") {
    return defaultDenyOutputPaths;
  }

  const runtimeDenyOutputPaths = (
    firstArgument as Record<string | symbol, unknown>
  )[RUNTIME_DENY_OUTPUT_PATHS];
  if (
    Array.isArray(runtimeDenyOutputPaths) &&
    runtimeDenyOutputPaths.every((path) => typeof path === "string")
  ) {
    return runtimeDenyOutputPaths;
  }

  return defaultDenyOutputPaths;
}

interface ProcessInputSyncResult {
  input: AISDKCallParams;
  outputPromise?: Promise<{
    output: {
      response_format: AISDKOutputResponseFormat;
    };
  }>;
}

const isZodSchema = (value: any): boolean => {
  return (
    value != null &&
    typeof value === "object" &&
    "_def" in value &&
    typeof value._def === "object"
  );
};

const serializeZodSchema = (schema: unknown): AISDKOutputResponseFormat => {
  try {
    return zodToJsonSchema(schema as any) as AISDKOutputResponseFormat;
  } catch {
    return {
      type: "object",
      description: "Zod schema (conversion failed)",
    };
  }
};

const isOutputObject = (value: unknown): value is AISDKOutputObject => {
  if (value == null || typeof value !== "object") {
    return false;
  }

  const output = value as AISDKOutputObject;
  if (!("responseFormat" in output)) {
    return false;
  }

  if (output.type === "object" || output.type === "text") {
    return true;
  }

  if (
    typeof output.responseFormat === "function" ||
    typeof output.responseFormat === "object"
  ) {
    return true;
  }

  return false;
};

const serializeOutputObject = (
  output: AISDKOutputObject,
  model: AISDKModel | undefined,
): {
  type?: string;
  response_format:
    | AISDKOutputResponseFormat
    | Promise<AISDKOutputResponseFormat>
    | null;
} => {
  try {
    const result: {
      type?: string;
      response_format:
        | AISDKOutputResponseFormat
        | Promise<AISDKOutputResponseFormat>
        | null;
    } = {
      response_format: null,
    };

    if (output.type) {
      result.type = output.type;
    }

    let responseFormat:
      | AISDKOutputResponseFormat
      | Promise<AISDKOutputResponseFormat>
      | undefined;

    if (typeof output.responseFormat === "function") {
      const mockModelForSchema = {
        supportsStructuredOutputs: true,
        ...(model && typeof model === "object" ? model : {}),
      };
      responseFormat = output.responseFormat({ model: mockModelForSchema });
    } else if (
      output.responseFormat != null &&
      typeof output.responseFormat === "object"
    ) {
      responseFormat = output.responseFormat;
    }

    if (responseFormat) {
      if (typeof responseFormat.then === "function") {
        result.response_format = Promise.resolve(responseFormat).then(
          (resolved) => {
            if (resolved.schema && isZodSchema(resolved.schema)) {
              return {
                ...resolved,
                schema: serializeZodSchema(resolved.schema),
              };
            }
            return resolved;
          },
        );
      } else {
        const syncResponseFormat = responseFormat as AISDKOutputResponseFormat;
        if (
          syncResponseFormat.schema &&
          isZodSchema(syncResponseFormat.schema)
        ) {
          responseFormat = {
            ...syncResponseFormat,
            schema: serializeZodSchema(syncResponseFormat.schema),
          };
        }
        result.response_format = responseFormat;
      }
    }

    return result;
  } catch {
    return {
      response_format: null,
    };
  }
};

const processInputAttachmentsSync = (
  input: AISDKCallParams,
): ProcessInputSyncResult => {
  if (!input) return { input };

  const processed: AISDKCallParams = { ...input };

  if (input.messages && Array.isArray(input.messages)) {
    processed.messages = input.messages.map(processMessage);
  }

  if (input.prompt && typeof input.prompt === "object") {
    if (Array.isArray(input.prompt)) {
      processed.prompt = input.prompt.map(processMessage);
    } else {
      processed.prompt = processPromptContent(input.prompt);
    }
  }

  if (input.schema && isZodSchema(input.schema)) {
    processed.schema = serializeZodSchema(input.schema);
  }

  if (input.callOptionsSchema && isZodSchema(input.callOptionsSchema)) {
    processed.callOptionsSchema = serializeZodSchema(input.callOptionsSchema);
  }

  if (input.tools) {
    processed.tools = serializeAISDKToolsForLogging(input.tools);
  }

  let outputPromise:
    | Promise<{
        output: {
          response_format: AISDKOutputResponseFormat;
        };
      }>
    | undefined;

  if (input.output && isOutputObject(input.output)) {
    const serialized = serializeOutputObject(input.output, input.model);

    if (
      serialized.response_format &&
      typeof serialized.response_format.then === "function"
    ) {
      processed.output = { ...serialized, response_format: {} };
      outputPromise = serialized.response_format.then(
        (resolvedFormat: AISDKOutputResponseFormat) => ({
          output: { ...serialized, response_format: resolvedFormat },
        }),
      );
    } else {
      processed.output = serialized;
    }
  }

  if (
    "prepareCall" in processed &&
    typeof processed.prepareCall === "function"
  ) {
    processed.prepareCall = "[Function]";
  }

  return { input: processed, outputPromise };
};

const processMessage = (message: any): any => {
  if (!message || typeof message !== "object") return message;

  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map(processContentPart),
    };
  }

  if (typeof message.content === "object" && message.content !== null) {
    return {
      ...message,
      content: processContentPart(message.content),
    };
  }

  return message;
};

const processPromptContent = (prompt: any): any => {
  if (Array.isArray(prompt)) {
    return prompt.map(processContentPart);
  }

  if (prompt.content) {
    if (Array.isArray(prompt.content)) {
      return {
        ...prompt,
        content: prompt.content.map(processContentPart),
      };
    } else if (typeof prompt.content === "object") {
      return {
        ...prompt,
        content: processContentPart(prompt.content),
      };
    }
  }

  return prompt;
};

const processContentPart = (part: any): any => {
  if (!part || typeof part !== "object") return part;

  try {
    if (part.type === "image" && part.image) {
      const imageAttachment = convertImageToAttachment(
        part.image,
        part.mimeType || part.mediaType,
      );
      if (imageAttachment) {
        return {
          ...part,
          image: imageAttachment,
        };
      }
    }

    if (
      part.type === "file" &&
      part.data &&
      (part.mimeType || part.mediaType)
    ) {
      const fileAttachment = convertDataToAttachment(
        part.data,
        part.mimeType || part.mediaType,
        part.name || part.filename,
      );
      if (fileAttachment) {
        return {
          ...part,
          data: fileAttachment,
        };
      }
    }

    if (part.type === "image_url" && part.image_url) {
      if (typeof part.image_url === "object" && part.image_url.url) {
        const imageAttachment = convertImageToAttachment(part.image_url.url);
        if (imageAttachment) {
          return {
            ...part,
            image_url: {
              ...part.image_url,
              url: imageAttachment,
            },
          };
        }
      }
    }
  } catch (error) {
    console.warn("Error processing content part:", error);
  }

  return part;
};

const convertImageToAttachment = (
  image: any,
  explicitMimeType?: string,
): Attachment | null => {
  try {
    if (typeof image === "string" && image.startsWith("data:")) {
      const [mimeTypeSection, base64Data] = image.split(",");
      const mimeType = mimeTypeSection.match(/data:(.*?);/)?.[1];
      if (mimeType && base64Data) {
        const blob = convertDataToBlob(base64Data, mimeType);
        if (blob) {
          return new Attachment({
            data: blob,
            filename: `image.${getExtensionFromMediaType(mimeType)}`,
            contentType: mimeType,
          });
        }
      }
    }

    if (explicitMimeType) {
      if (image instanceof Uint8Array) {
        return new Attachment({
          data: new Blob([image], { type: explicitMimeType }),
          filename: `image.${getExtensionFromMediaType(explicitMimeType)}`,
          contentType: explicitMimeType,
        });
      }

      if (typeof Buffer !== "undefined" && Buffer.isBuffer(image)) {
        return new Attachment({
          data: new Blob([image], { type: explicitMimeType }),
          filename: `image.${getExtensionFromMediaType(explicitMimeType)}`,
          contentType: explicitMimeType,
        });
      }
    }

    if (image instanceof Blob && image.type) {
      return new Attachment({
        data: image,
        filename: `image.${getExtensionFromMediaType(image.type)}`,
        contentType: image.type,
      });
    }

    if (image instanceof Attachment) {
      return image;
    }
  } catch (error) {
    console.warn("Error converting image to attachment:", error);
  }

  return null;
};

const convertDataToAttachment = (
  data: any,
  mimeType: string,
  filename?: string,
): Attachment | null => {
  if (!mimeType) return null;

  try {
    let blob: Blob | null = null;

    if (typeof data === "string" && data.startsWith("data:")) {
      const [, base64Data] = data.split(",");
      if (base64Data) {
        blob = convertDataToBlob(base64Data, mimeType);
      }
    } else if (typeof data === "string" && data.length > 0) {
      blob = convertDataToBlob(data, mimeType);
    } else if (data instanceof Uint8Array) {
      blob = new Blob([data], { type: mimeType });
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      blob = new Blob([data], { type: mimeType });
    } else if (data instanceof Blob) {
      blob = data;
    }

    if (blob) {
      return new Attachment({
        data: blob,
        filename: filename || `file.${getExtensionFromMediaType(mimeType)}`,
        contentType: mimeType,
      });
    }
  } catch (error) {
    console.warn("Error converting data to attachment:", error);
  }

  return null;
};

/**
 * Process AI SDK input parameters, converting attachments as needed.
 */
function processAISDKInput(params: AISDKCallParams): ProcessInputSyncResult {
  return processInputAttachmentsSync(params);
}

function prepareAISDKInput(
  params: AISDKCallParams,
  event: {
    aiSDK?: AISDK;
    denyOutputPaths?: string[];
    self?: unknown;
    [key: string]: unknown;
  },
  span: Span,
  defaultDenyOutputPaths: string[],
): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const { input, outputPromise } = processAISDKInput(params);
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
        // Use the placeholder response_format if async resolution fails.
      });
  }

  const metadata = extractMetadataFromParams(params, event.self);
  const childTracing = prepareAISDKChildTracing(
    params,
    event.self,
    span,
    defaultDenyOutputPaths,
    event.aiSDK,
  );
  event.modelWrapped = childTracing.modelWrapped;
  if (childTracing.cleanup) {
    event.__braintrust_ai_sdk_cleanup = childTracing.cleanup;
  }

  return {
    input,
    metadata,
  };
}

function extractTopLevelAISDKMetrics(
  result: AISDKResult,
  event?: { [key: string]: unknown },
  startTime?: number,
): Record<string, number> {
  const metrics = hasModelChildTracing(event)
    ? {}
    : extractTokenMetrics(result);

  if (startTime) {
    metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
  }

  return metrics;
}

function hasModelChildTracing(event?: { [key: string]: unknown }): boolean {
  return (
    event?.modelWrapped === true ||
    event?.__braintrust_ai_sdk_model_wrapped === true
  );
}

/**
 * Extract metadata from AI SDK parameters.
 * Includes model, provider, and integration info.
 */
function extractMetadataFromParams(
  params: AISDKCallParams,
  self?: unknown,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    braintrust: {
      integration_name: "ai-sdk",
      sdk_language: "typescript",
    },
  };

  // Extract model information
  const agentModel =
    self &&
    typeof self === "object" &&
    "model" in self &&
    (self as { model?: AISDKModel }).model
      ? (self as { model?: AISDKModel }).model
      : self &&
          typeof self === "object" &&
          "settings" in self &&
          (self as { settings?: { model?: AISDKModel } }).settings?.model
        ? (self as { settings?: { model?: AISDKModel } }).settings?.model
        : undefined;
  const { model, provider } = serializeModelWithProvider(
    params.model ?? agentModel,
  );
  if (model) {
    metadata.model = model;
  }
  if (provider) {
    metadata.provider = provider;
  }
  const tools = serializeAISDKToolsForLogging(params.tools);
  if (tools) {
    metadata.tools = tools;
  }

  return metadata;
}

function prepareAISDKChildTracing(
  params: AISDKCallParams,
  self: unknown,
  parentSpan: Span,
  denyOutputPaths: string[],
  aiSDK?: AISDK,
): {
  cleanup?: () => void;
  modelWrapped: boolean;
} {
  const cleanup: Array<() => void> = [];
  const patchedModels = new WeakSet<object>();
  const patchedTools = new WeakSet<object>();
  let modelWrapped = false;

  const patchModel = (
    model: AISDKModel | undefined,
  ): AISDKModel | undefined => {
    const resolvedModel = resolveAISDKModel(model, aiSDK);
    if (
      !resolvedModel ||
      typeof resolvedModel !== "object" ||
      typeof resolvedModel.doGenerate !== "function" ||
      patchedModels.has(resolvedModel) ||
      (resolvedModel as { [AUTO_PATCHED_MODEL]?: boolean })[AUTO_PATCHED_MODEL]
    ) {
      return resolvedModel;
    }

    patchedModels.add(resolvedModel);
    (resolvedModel as { [AUTO_PATCHED_MODEL]?: boolean })[AUTO_PATCHED_MODEL] =
      true;
    modelWrapped = true;

    const originalDoGenerate = resolvedModel.doGenerate;
    const originalDoStream = resolvedModel.doStream;
    const baseMetadata = buildAISDKChildMetadata(resolvedModel);

    resolvedModel.doGenerate = async function doGeneratePatched(
      options: AISDKCallParams,
    ) {
      return parentSpan.traced(
        async (span) => {
          const result = await Reflect.apply(
            originalDoGenerate,
            resolvedModel,
            [options],
          );

          span.log({
            output: processAISDKOutput(result, denyOutputPaths),
            metrics: extractTokenMetrics(result),
            ...buildResolvedMetadataPayload(result),
          });

          return result;
        },
        {
          name: "doGenerate",
          spanAttributes: {
            type: SpanTypeAttribute.LLM,
          },
          event: {
            input: processAISDKInput(options).input,
            metadata: baseMetadata,
          },
        },
      );
    };

    if (originalDoStream) {
      resolvedModel.doStream = async function doStreamPatched(
        options: AISDKCallParams,
      ) {
        const span = parentSpan.startSpan({
          name: "doStream",
          spanAttributes: {
            type: SpanTypeAttribute.LLM,
          },
          event: {
            input: processAISDKInput(options).input,
            metadata: baseMetadata,
          },
        });

        const result = await withCurrent(span, () =>
          Reflect.apply(originalDoStream, resolvedModel, [options]),
        );
        const streamStartTime = getCurrentUnixTimestamp();
        let firstChunkTime: number | undefined;
        const output: Record<string, unknown> = {};
        let text = "";
        let reasoning = "";
        const toolCalls: unknown[] = [];
        let object: unknown = undefined;

        const transformStream = new TransformStream({
          transform(chunk: AISDKModelStreamChunk, controller) {
            if (firstChunkTime === undefined) {
              firstChunkTime = getCurrentUnixTimestamp();
            }

            switch (chunk.type) {
              case "text-delta":
                text += extractTextDelta(chunk);
                break;
              case "reasoning-delta":
                if (chunk.delta) {
                  reasoning += chunk.delta;
                } else if (chunk.text) {
                  reasoning += chunk.text;
                }
                break;
              case "tool-call":
                toolCalls.push(chunk);
                break;
              case "object":
                object = chunk.object;
                break;
              case "raw":
                if (chunk.rawValue) {
                  const rawVal = chunk.rawValue as {
                    choices?: Array<{ delta?: { content?: string } }>;
                    content?: string;
                    delta?: { content?: string };
                    text?: string;
                  };
                  if (rawVal.delta?.content) {
                    text += rawVal.delta.content;
                  } else if (rawVal.choices?.[0]?.delta?.content) {
                    text += rawVal.choices[0].delta.content;
                  } else if (typeof rawVal.text === "string") {
                    text += rawVal.text;
                  } else if (typeof rawVal.content === "string") {
                    text += rawVal.content;
                  }
                }
                break;
              case "finish":
                output.text = text;
                output.reasoning = reasoning;
                output.toolCalls = toolCalls;
                output.finishReason = chunk.finishReason;
                output.usage = chunk.usage;

                if (object !== undefined) {
                  output.object = object;
                }

                const metrics = extractTokenMetrics(output as AISDKResult);
                if (firstChunkTime !== undefined) {
                  metrics.time_to_first_token = Math.max(
                    firstChunkTime - streamStartTime,
                    1e-6,
                  );
                }

                span.log({
                  output: processAISDKOutput(
                    output as AISDKResult,
                    denyOutputPaths,
                  ),
                  metrics,
                  ...buildResolvedMetadataPayload(output as AISDKResult),
                });
                span.end();
                break;
            }
            controller.enqueue(chunk);
          },
        });

        return {
          ...result,
          stream: result.stream.pipeThrough(transformStream),
        };
      };
    }

    cleanup.push(() => {
      resolvedModel.doGenerate = originalDoGenerate;
      if (originalDoStream) {
        resolvedModel.doStream = originalDoStream;
      }
      delete (resolvedModel as { [AUTO_PATCHED_MODEL]?: boolean })[
        AUTO_PATCHED_MODEL
      ];
    });

    return resolvedModel;
  };

  const patchTool = (tool: AISDKTool, name: string): void => {
    if (
      tool == null ||
      typeof tool !== "object" ||
      !("execute" in tool) ||
      typeof tool.execute !== "function" ||
      patchedTools.has(tool) ||
      (tool as { [AUTO_PATCHED_TOOL]?: boolean })[AUTO_PATCHED_TOOL]
    ) {
      return;
    }

    patchedTools.add(tool);
    (tool as { [AUTO_PATCHED_TOOL]?: boolean })[AUTO_PATCHED_TOOL] = true;
    const originalExecute = tool.execute;
    tool.execute = function executePatched(...args: unknown[]) {
      const result = Reflect.apply(originalExecute, this, args);

      if (isAsyncGenerator(result)) {
        return (async function* () {
          const span = parentSpan.startSpan({
            name,
            spanAttributes: {
              type: SpanTypeAttribute.TOOL,
            },
          });
          span.log({ input: args.length === 1 ? args[0] : args });

          try {
            let lastValue: unknown;
            for await (const value of result) {
              lastValue = value;
              yield value;
            }
            span.log({ output: lastValue });
          } catch (error) {
            span.log({
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            span.end();
          }
        })();
      }

      return parentSpan.traced(
        async (span) => {
          span.log({ input: args.length === 1 ? args[0] : args });
          const awaitedResult = await result;
          span.log({ output: awaitedResult });
          return awaitedResult;
        },
        {
          name,
          spanAttributes: {
            type: SpanTypeAttribute.TOOL,
          },
        },
      );
    };

    cleanup.push(() => {
      tool.execute = originalExecute;
      delete (tool as { [AUTO_PATCHED_TOOL]?: boolean })[AUTO_PATCHED_TOOL];
    });
  };

  const patchTools = (tools: AISDKTools | undefined): void => {
    if (!tools) {
      return;
    }

    const inferName = (tool: AISDKTool, fallback: string) =>
      (tool && (tool.name || tool.toolName || tool.id)) || fallback;

    if (Array.isArray(tools)) {
      tools.forEach((tool, index) =>
        patchTool(tool, inferName(tool, `tool[${index}]`)),
      );
      return;
    }

    for (const [key, tool] of Object.entries(tools)) {
      patchTool(tool, key);
    }
  };

  if (params && typeof params === "object") {
    const patchedParamModel = patchModel(params.model);
    if (
      typeof params.model === "string" &&
      patchedParamModel &&
      typeof patchedParamModel === "object"
    ) {
      params.model = patchedParamModel;
    }
    patchTools(params.tools);
  }

  if (self && typeof self === "object") {
    const selfRecord = self as {
      model?: AISDKModel;
      settings?: { model?: AISDKModel; tools?: AISDKTools };
    };

    if (selfRecord.model !== undefined) {
      const patchedSelfModel = patchModel(selfRecord.model);
      if (
        typeof selfRecord.model === "string" &&
        patchedSelfModel &&
        typeof patchedSelfModel === "object"
      ) {
        selfRecord.model = patchedSelfModel;
      }
    }

    if (selfRecord.settings && typeof selfRecord.settings === "object") {
      if (selfRecord.settings.model !== undefined) {
        const patchedSettingsModel = patchModel(selfRecord.settings.model);
        if (
          typeof selfRecord.settings.model === "string" &&
          patchedSettingsModel &&
          typeof patchedSettingsModel === "object"
        ) {
          selfRecord.settings.model = patchedSettingsModel;
        }
      }
      if (selfRecord.settings.tools !== undefined) {
        patchTools(selfRecord.settings.tools);
      }
    }
  }

  return {
    cleanup:
      cleanup.length > 0
        ? () => {
            while (cleanup.length > 0) {
              cleanup.pop()?.();
            }
          }
        : undefined,
    modelWrapped,
  };
}

function finalizeAISDKChildTracing(event?: { [key: string]: unknown }): void {
  const cleanup = event?.__braintrust_ai_sdk_cleanup;
  if (event && typeof cleanup === "function") {
    cleanup();
    delete event.__braintrust_ai_sdk_cleanup;
  }
}

function patchAISDKStreamingResult(args: {
  defaultDenyOutputPaths: string[];
  endEvent: { denyOutputPaths?: string[]; [key: string]: unknown };
  result: AISDKResult;
  span: Span;
  startTime: number;
}): boolean {
  const { defaultDenyOutputPaths, endEvent, result, span, startTime } = args;

  if (!result || typeof result !== "object") {
    return false;
  }

  const resultRecord = result as Record<string, unknown>;
  attachKnownResultPromiseHandlers(resultRecord);

  if (isReadableStreamLike(resultRecord.baseStream)) {
    let firstChunkTime: number | undefined;

    const wrappedBaseStream = resultRecord.baseStream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (firstChunkTime === undefined) {
            firstChunkTime = getCurrentUnixTimestamp();
          }
          controller.enqueue(chunk);
        },
        async flush() {
          const metrics = extractTopLevelAISDKMetrics(result, endEvent);
          if (
            metrics.time_to_first_token === undefined &&
            firstChunkTime !== undefined
          ) {
            metrics.time_to_first_token = firstChunkTime - startTime;
          }

          const output = await processAISDKStreamingOutput(
            result,
            resolveDenyOutputPaths(endEvent, defaultDenyOutputPaths),
          );
          const metadata = buildResolvedMetadataPayload(result).metadata;

          span.log({
            output,
            ...(metadata ? { metadata } : {}),
            metrics,
          });

          finalizeAISDKChildTracing(endEvent);
          span.end();
        },
      }),
    );

    Object.defineProperty(resultRecord, "baseStream", {
      configurable: true,
      enumerable: true,
      value: wrappedBaseStream,
      writable: true,
    });

    return true;
  }

  const streamField = findAsyncIterableField(resultRecord, [
    "partialObjectStream",
    "textStream",
    "fullStream",
    "stream",
  ]);
  if (!streamField) {
    return false;
  }

  let firstChunkTime: number | undefined;
  const wrappedStream = createPatchedAsyncIterable(streamField.stream, {
    onChunk: () => {
      if (firstChunkTime === undefined) {
        firstChunkTime = getCurrentUnixTimestamp();
      }
    },
    onComplete: async () => {
      const metrics = extractTopLevelAISDKMetrics(result, endEvent);
      if (
        metrics.time_to_first_token === undefined &&
        firstChunkTime !== undefined
      ) {
        metrics.time_to_first_token = firstChunkTime - startTime;
      }

      const output = await processAISDKStreamingOutput(
        result,
        resolveDenyOutputPaths(endEvent, defaultDenyOutputPaths),
      );
      const metadata = buildResolvedMetadataPayload(result).metadata;

      span.log({
        output,
        ...(metadata ? { metadata } : {}),
        metrics,
      });
      finalizeAISDKChildTracing(endEvent);
      span.end();
    },
    onError: (error) => {
      span.log({
        error: error.message,
      });
      finalizeAISDKChildTracing(endEvent);
      span.end();
    },
  });

  Object.defineProperty(resultRecord, streamField.field, {
    configurable: true,
    enumerable: true,
    value: wrappedStream,
    writable: true,
  });

  return true;
}

function attachKnownResultPromiseHandlers(
  result: Record<string, unknown>,
): void {
  const promiseLikeFields = [
    "content",
    "text",
    "object",
    "finishReason",
    "usage",
    "totalUsage",
    "steps",
  ];

  for (const field of promiseLikeFields) {
    try {
      if (!(field in result)) {
        continue;
      }
      const value = result[field];
      if (isPromiseLike(value)) {
        void Promise.resolve(value).catch(() => {});
      }
    } catch {
      // Ignore getter failures while attaching safeguards.
    }
  }
}

function isReadableStreamLike(value: unknown): value is {
  pipeThrough<T>(transform: TransformStream<unknown, T>): ReadableStream<T>;
} {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { pipeThrough?: unknown }).pipeThrough === "function"
  );
}

function isAsyncIterableLike(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

function findAsyncIterableField(
  result: Record<string, unknown>,
  candidateFields: string[],
): { field: string; stream: AsyncIterable<unknown> } | null {
  for (const field of candidateFields) {
    try {
      const stream = result[field];
      if (isAsyncIterableLike(stream)) {
        return { field, stream };
      }
    } catch {
      // Ignore getter failures.
    }
  }

  return null;
}

function createPatchedAsyncIterable(
  stream: AsyncIterable<unknown>,
  hooks: {
    onChunk: (chunk: unknown) => void;
    onComplete: () => Promise<void>;
    onError: (error: Error) => void;
  },
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          hooks.onChunk(chunk);
          yield chunk;
        }
        await hooks.onComplete();
      } catch (error) {
        hooks.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }
    },
  };
}

async function processAISDKStreamingOutput(
  result: AISDKResult,
  denyOutputPaths: string[],
): Promise<Record<string, unknown> | AISDKResult> {
  const output = processAISDKOutput(result, denyOutputPaths);

  if (!output || typeof output !== "object") {
    return output;
  }

  const outputRecord = output as Record<string, unknown>;
  const isObjectStreamingResult =
    result != null &&
    typeof result === "object" &&
    "partialObjectStream" in result;

  try {
    // Object-stream results can expose a text getter that rejects when no text
    // output exists. Skip probing text for those streams.
    if (!isObjectStreamingResult && "text" in result) {
      const resolvedText = await Promise.resolve(result.text);
      if (typeof resolvedText === "string") {
        outputRecord.text = resolvedText;
      }
    }
  } catch {
    // Ignore getter failures
  }

  try {
    if ("object" in result) {
      const resolvedObject = await Promise.resolve(result.object);
      if (resolvedObject !== undefined) {
        outputRecord.object = resolvedObject;
      }
    }
  } catch {
    // Ignore getter/promise failures
  }

  try {
    if ("finishReason" in result) {
      const resolvedFinishReason = await Promise.resolve(result.finishReason);
      if (resolvedFinishReason !== undefined) {
        outputRecord.finishReason = resolvedFinishReason;
      }
    }
  } catch {
    // Ignore getter/promise failures
  }

  return outputRecord;
}

function buildAISDKChildMetadata(
  model: AISDKModel | undefined,
): Record<string, unknown> {
  const { model: modelId, provider } = serializeModelWithProvider(model);

  return {
    ...(modelId ? { model: modelId } : {}),
    ...(provider ? { provider } : {}),
    braintrust: {
      integration_name: "ai-sdk",
      sdk_language: "typescript",
    },
  };
}

function buildResolvedMetadataPayload(result: AISDKResult): {
  metadata?: Record<string, unknown>;
} {
  const gatewayInfo = extractGatewayRoutingInfo(result);
  const metadata: Record<string, unknown> = {};

  if (gatewayInfo?.provider) {
    metadata.provider = gatewayInfo.provider;
  }
  if (gatewayInfo?.model) {
    metadata.model = gatewayInfo.model;
  }

  let finishReason: unknown;
  try {
    finishReason = result.finishReason;
  } catch {
    finishReason = undefined;
  }

  if (isPromiseLike(finishReason)) {
    void Promise.resolve(finishReason).catch(() => {});
  } else if (finishReason !== undefined) {
    metadata.finish_reason = finishReason;
  }

  return Object.keys(metadata).length > 0 ? { metadata } : {};
}

function resolveAISDKModel(
  model: AISDKModel | undefined,
  aiSDK?: AISDK,
): AISDKModel | undefined {
  if (typeof model !== "string") {
    return model;
  }

  const provider =
    (
      globalThis as typeof globalThis & {
        AI_SDK_DEFAULT_PROVIDER?: {
          languageModel?: (modelId: string) => AISDKLanguageModel;
        };
      }
    ).AI_SDK_DEFAULT_PROVIDER ??
    aiSDK?.gateway ??
    null;

  if (provider && typeof provider.languageModel === "function") {
    return provider.languageModel(model);
  }

  return model;
}

function extractTextDelta(chunk: AISDKModelStreamChunk): string {
  if (typeof chunk.textDelta === "string") return chunk.textDelta;
  if (typeof chunk.delta === "string") return chunk.delta;
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.content === "string") return chunk.content;
  return "";
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as AsyncGenerator)[Symbol.asyncIterator] === "function" &&
    typeof (value as AsyncGenerator).next === "function" &&
    typeof (value as AsyncGenerator).return === "function" &&
    typeof (value as AsyncGenerator).throw === "function"
  );
}

/**
 * Process AI SDK output, omitting specified paths.
 */
function processAISDKOutput(
  output: AISDKResult,
  denyOutputPaths: string[],
): Record<string, unknown> | AISDKResult {
  if (!output) return output;

  const merged = extractSerializableOutputFields(output);

  // Apply omit to remove unwanted paths
  return normalizeAISDKLoggedOutput(omit(merged, denyOutputPaths));
}

/**
 * Extract token metrics from AI SDK result.
 */
function extractTokenMetrics(result: AISDKResult): Record<string, number> {
  const metrics: Record<string, number> = {};

  let usage: AISDKUsage | undefined;
  const totalUsageValue = safeResultFieldRead(result, "totalUsage");
  if (totalUsageValue !== undefined && !isPromiseLike(totalUsageValue)) {
    usage = totalUsageValue as AISDKUsage;
  }

  if (!usage) {
    const usageValue = safeResultFieldRead(result, "usage");
    if (usageValue !== undefined && !isPromiseLike(usageValue)) {
      usage = usageValue as AISDKUsage;
    }
  }

  if (!usage) {
    return metrics;
  }

  // Extract token counts
  const promptTokens = firstNumber(
    usage.inputTokens?.total,
    usage.inputTokens,
    usage.promptTokens,
    usage.prompt_tokens,
  );
  if (promptTokens !== undefined) {
    metrics.prompt_tokens = promptTokens;
  }

  const completionTokens = firstNumber(
    usage.outputTokens?.total,
    usage.outputTokens,
    usage.completionTokens,
    usage.completion_tokens,
  );
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }

  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.tokens,
    usage.total_tokens,
  );
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  }

  // Extract cost from gateway routing if available
  const cost = extractCostFromResult(result);
  if (cost !== undefined) {
    metrics.estimated_cost = cost;
  }

  return metrics;
}

function safeResultFieldRead(
  result: AISDKResult,
  field: "usage" | "totalUsage",
): unknown {
  return safeSerializableFieldRead(result, field);
}

function safeSerializableFieldRead(
  obj: Record<string, unknown> | AISDKResult,
  field: string,
): unknown {
  try {
    const value = obj?.[field as keyof typeof obj];
    if (isPromiseLike(value)) {
      void Promise.resolve(value).catch(() => {});
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Aggregate AI SDK streaming chunks into a single response.
 */
function aggregateAISDKChunks(
  chunks: unknown[],
  _result?: AISDKResult | AsyncIterable<unknown>,
  endEvent?: { [key: string]: unknown },
): {
  output: Record<string, unknown>;
  metrics: Record<string, number>;
  metadata?: Record<string, unknown>;
} {
  // For AI SDK streams, the chunks are typically delta objects
  // We'll return the last chunk which usually contains the final state
  const lastChunk = chunks[chunks.length - 1] as AISDKResult | undefined;

  const output: Record<string, unknown> = {};
  let metrics: Record<string, number> = {};
  let metadata: Record<string, unknown> | undefined;

  // Extract usage from last chunk
  if (lastChunk) {
    metrics = hasModelChildTracing(endEvent)
      ? {}
      : extractTokenMetrics(lastChunk);
    metadata = buildResolvedMetadataPayload(lastChunk).metadata;

    // Extract common output fields
    const text = safeSerializableFieldRead(lastChunk, "text");
    if (text !== undefined) {
      output.text = text;
    }
    const objectValue = safeSerializableFieldRead(lastChunk, "object");
    if (objectValue !== undefined) {
      output.object = objectValue;
    }
    const finishReason = safeSerializableFieldRead(lastChunk, "finishReason");
    if (finishReason !== undefined) {
      output.finishReason = finishReason;
    }
    const toolCalls = safeSerializableFieldRead(lastChunk, "toolCalls");
    if (toolCalls !== undefined) {
      output.toolCalls = toolCalls;
    }
  }

  finalizeAISDKChildTracing(endEvent);

  return { output, metrics, metadata };
}

/**
 * Extract getter values from AI SDK result objects.
 */
function extractGetterValues(
  obj: AISDKResult,
): Partial<Record<string, unknown>> {
  const getterValues: Record<string, unknown> = {};

  const getterNames = [
    "content",
    "text",
    "object",
    "finishReason",
    "usage",
    "totalUsage",
    "toolCalls",
    "toolResults",
    "warnings",
    "experimental_providerMetadata",
    "providerMetadata",
    "rawResponse",
    "response",
  ];

  for (const name of getterNames) {
    try {
      if (!obj || !(name in obj)) {
        continue;
      }

      const value = obj[name];
      if (isPromiseLike(value)) {
        // Some AI SDK getters return promises that may reject when no output
        // was generated. Consume rejections for values we are not logging.
        void Promise.resolve(value).catch(() => {});
        continue;
      }

      if (isSerializableOutputValue(value)) {
        getterValues[name] = value;
      }
    } catch {
      // Ignore errors accessing getters
    }
  }

  return getterValues;
}

function extractSerializableOutputFields(
  output: AISDKResult,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  const directFieldNames = [
    "steps",
    "request",
    "responseMessages",
    "warnings",
    "rawResponse",
    "response",
    "providerMetadata",
    "experimental_providerMetadata",
  ] as const;

  for (const name of directFieldNames) {
    try {
      const value = output?.[name];
      if (isPromiseLike(value)) {
        void Promise.resolve(value).catch(() => {});
        continue;
      }
      if (isSerializableOutputValue(value)) {
        serialized[name] = value;
      }
    } catch {
      // Ignore errors accessing getters
    }
  }

  return {
    ...serialized,
    ...extractGetterValues(output),
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isSerializableOutputValue(value: unknown): boolean {
  if (typeof value === "function") {
    return false;
  }

  if (
    value &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    return false;
  }

  if (
    value &&
    typeof value === "object" &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  ) {
    return false;
  }

  if (
    value &&
    typeof value === "object" &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  ) {
    return false;
  }

  return true;
}

/**
 * Extracts model ID and provider from a model object or string.
 */
function serializeModelWithProvider(model: AISDKModel | undefined): {
  model: string | undefined;
  provider?: string;
} {
  const modelId = typeof model === "string" ? model : model?.modelId;
  const explicitProvider =
    typeof model === "object" ? model?.provider : undefined;

  if (!modelId) {
    return { model: modelId, provider: explicitProvider };
  }

  // Parse gateway-style model strings like "openai/gpt-4"
  const parsed = parseGatewayModelString(modelId);
  return {
    model: parsed.model,
    provider: explicitProvider || parsed.provider,
  };
}

/**
 * Parse gateway model string like "openai/gpt-4" into provider and model.
 */
function parseGatewayModelString(modelString: string): {
  model: string;
  provider?: string;
} {
  if (!modelString || typeof modelString !== "string") {
    return { model: modelString };
  }
  const slashIndex = modelString.indexOf("/");
  if (slashIndex > 0 && slashIndex < modelString.length - 1) {
    return {
      provider: modelString.substring(0, slashIndex),
      model: modelString.substring(slashIndex + 1),
    };
  }
  return { model: modelString };
}

function extractGatewayRoutingInfo(result: AISDKResult): {
  model?: string;
  provider?: string;
} | null {
  const steps = safeSerializableFieldRead(result, "steps");
  if (Array.isArray(steps) && steps.length > 0) {
    const routing = (steps[0] as { providerMetadata?: any })?.providerMetadata
      ?.gateway?.routing;
    if (routing) {
      return {
        provider: routing.resolvedProvider || routing.finalProvider,
        model: routing.resolvedProviderApiModelId,
      };
    }
  }

  const providerMetadata = safeSerializableFieldRead(
    result,
    "providerMetadata",
  );
  const routing = (providerMetadata as { gateway?: any } | undefined)?.gateway
    ?.routing;
  if (routing) {
    return {
      provider: routing.resolvedProvider || routing.finalProvider,
      model: routing.resolvedProviderApiModelId,
    };
  }

  return null;
}

/**
 * Extract cost from result's providerMetadata.
 */
function extractCostFromResult(result: AISDKResult): number | undefined {
  // Check for cost in steps (multi-step results)
  const steps = safeSerializableFieldRead(result, "steps");
  if (Array.isArray(steps) && steps.length > 0) {
    let totalCost = 0;
    let foundCost = false;
    for (const step of steps) {
      const gateway = step?.providerMetadata?.gateway;
      const stepCost =
        parseGatewayCost(gateway?.cost) ||
        parseGatewayCost(gateway?.marketCost);
      if (stepCost !== undefined && stepCost > 0) {
        totalCost += stepCost;
        foundCost = true;
      }
    }
    if (foundCost) {
      return totalCost;
    }
  }

  // Check direct providerMetadata
  const providerMetadata = safeSerializableFieldRead(
    result,
    "providerMetadata",
  );
  const gateway = (providerMetadata as { gateway?: any } | undefined)?.gateway;
  const directCost =
    parseGatewayCost(gateway?.cost) || parseGatewayCost(gateway?.marketCost);
  if (directCost !== undefined && directCost > 0) {
    return directCost;
  }

  return undefined;
}

/**
 * Parse gateway cost value.
 */
function parseGatewayCost(cost: unknown): number | undefined {
  if (cost === undefined || cost === null) {
    return undefined;
  }
  if (typeof cost === "number") {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = parseFloat(cost);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Get first number from a list of values.
 */
function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number") {
      return v;
    }
  }
  return undefined;
}

/**
 * Deep copy an object via JSON serialization.
 */
function deepCopy(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Parse a JSON path string into an array of keys.
 */
function parsePath(path: string): (string | number)[] {
  const keys: (string | number)[] = [];
  let current = "";

  for (let i = 0; i < path.length; i++) {
    const char = path[i];

    if (char === ".") {
      if (current) {
        keys.push(current);
        current = "";
      }
    } else if (char === "[") {
      if (current) {
        keys.push(current);
        current = "";
      }
      let bracketContent = "";
      i++;
      while (i < path.length && path[i] !== "]") {
        bracketContent += path[i];
        i++;
      }
      if (bracketContent === "") {
        keys.push("[]");
      } else {
        const index = parseInt(bracketContent, 10);
        keys.push(isNaN(index) ? bracketContent : index);
      }
    } else {
      current += char;
    }
  }

  if (current) {
    keys.push(current);
  }

  return keys;
}

/**
 * Omit a value at a specific path in an object.
 */
function omitAtPath(
  obj: Record<string, unknown> | unknown[] | undefined,
  keys: (string | number)[],
): void {
  if (keys.length === 0) return;

  const firstKey = keys[0];
  const remainingKeys = keys.slice(1);

  if (firstKey === "[]") {
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (remainingKeys.length > 0) {
          omitAtPath(
            item as Record<string, unknown> | unknown[] | undefined,
            remainingKeys,
          );
        }
      });
    }
  } else if (remainingKeys.length === 0) {
    if (obj && typeof obj === "object" && firstKey in obj) {
      (obj as Record<string | number, unknown>)[firstKey] = "<omitted>";
    }
  } else {
    if (obj && typeof obj === "object" && firstKey in obj) {
      omitAtPath(
        (obj as Record<string | number, unknown>)[firstKey] as
          | Record<string, unknown>
          | unknown[]
          | undefined,
        remainingKeys,
      );
    }
  }
}

/**
 * Omit specified paths from an object.
 */
function omit(
  obj: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  const result = deepCopy(obj);

  for (const path of paths) {
    const keys = parsePath(path);
    omitAtPath(result, keys);
  }

  return result;
}
