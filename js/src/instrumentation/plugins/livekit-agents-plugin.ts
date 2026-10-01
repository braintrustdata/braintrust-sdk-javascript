import { isObject, isPromiseLike, SpanTypeAttribute } from "../../../util";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent, type Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type {
  LiveKitAgent,
  LiveKitAudioFrame,
  LiveKitChatContext,
  LiveKitNodeArgs,
  LiveKitNodeName,
  LiveKitNodeResult,
  LiveKitTool,
  LiveKitToolContext,
} from "../../vendor-sdk-types/livekit-agents";
import { isAutoCaptureAttachmentsEnabled } from "../../wrappers/attachment-utils";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationAllowed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { observeStream } from "../core/stream-patcher";
import { liveKitAgentsChannels } from "./livekit-agents-channels";
import {
  copyLiveKitAudio,
  liveKitAudioParts,
  liveKitMessages,
  liveKitToolDefinitions,
  liveKitToolValue,
} from "./livekit-agents-data";

const NODE_MODELS = { sttNode: "stt", llmNode: "llm", ttsNode: "tts" } as const;

// LiveKit plugins report their API host as the provider.
const PROVIDERS_BY_HOST = new Map([
  ["api.openai.com", "openai"],
  ["api.anthropic.com", "anthropic"],
  ["generativelanguage.googleapis.com", "google"],
  ["api.deepgram.com", "deepgram"],
  ["api.elevenlabs.io", "elevenlabs"],
  ["api.cartesia.ai", "cartesia"],
  ["openrouter.ai", "openrouter"],
]);

const LLM_USAGE_METRICS = [
  ["promptTokens", "prompt_tokens"],
  ["completionTokens", "completion_tokens"],
  ["totalTokens", "tokens"],
  ["promptCachedTokens", "prompt_cached_tokens"],
  ["cacheCreationTokens", "prompt_cache_creation_tokens"],
  ["reasoningTokens", "completion_reasoning_tokens"],
] as const;

// LiveKit SpeechEventType values.
const INTERIM_TRANSCRIPT = 1;
const FINAL_TRANSCRIPT = 2;
const RECOGNITION_USAGE = 4;

const wrappedExecutors = new WeakSet<NonNullable<LiveKitTool["execute"]>>();

export class LiveKitAgentsPlugin extends BasePlugin {
  protected onEnable(): void {
    for (const [method, defaultChannel] of [
      ["sttNode", "defaultSttNode"],
      ["llmNode", "defaultLlmNode"],
      ["ttsNode", "defaultTtsNode"],
    ] as const) {
      this.unsubscribers.push(
        liveKitAgentsChannels[method].intercept((target, self, args) =>
          traceNode(method, self as LiveKitAgent, args, () =>
            target.apply(self, args),
          ),
        ),
        liveKitAgentsChannels[defaultChannel].intercept((target, self, args) =>
          traceNode(method, args[0], args.slice(1) as LiveKitNodeArgs, () =>
            target.apply(self, args),
          ),
        ),
      );
    }
    this.unsubscribers.push(
      liveKitAgentsChannels.tool.intercept((target, self, args) => {
        const tool = target.apply(self, args);
        instrumentTool(tool);
        return tool;
      }),
      liveKitAgentsChannels.executeTool.intercept(
        (target, self, args, { name }) => {
          const capture = isAutoCaptureAttachmentsEnabled();
          const span = startSpan(
            withSpanInstrumentationName(
              {
                name: name || "livekit.tool.execute",
                spanAttributes: { type: SpanTypeAttribute.TOOL },
              },
              INSTRUMENTATION_NAMES.LIVEKIT_AGENTS,
            ),
          );
          logSafely(span, "tool input", () => ({
            input: liveKitToolValue(args[0], capture),
          }));
          const finish = (output: unknown) => {
            logSafely(span, "tool output", () => ({
              output: liveKitToolValue(output, capture),
            }));
            span.end();
          };
          const fail = (error: unknown) => {
            span.log({ error });
            span.end();
          };
          let result: unknown;
          try {
            result = withCurrent(span, () =>
              runWithAutoInstrumentationAllowed(() => target.apply(self, args)),
            );
          } catch (error) {
            fail(error);
            throw error;
          }
          if (isPromiseLike(result))
            void Promise.resolve(result).then(finish, fail);
          else finish(result);
          return result;
        },
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function instrumentTool(tool: LiveKitTool): void {
  const execute = tool.execute;
  if (typeof execute !== "function" || wrappedExecutors.has(execute)) return;
  const wrapped: typeof execute = function (this: LiveKitTool, ...args) {
    return liveKitAgentsChannels.executeTool.invoke(execute, this, args, {
      name: args[1]?.ctx?.functionCall?.name ?? this?.name ?? tool.name,
    });
  };
  try {
    tool.execute = wrapped;
    wrappedExecutors.add(wrapped);
  } catch (error) {
    debugLogger.warn("Cannot wrap LiveKit tool", error);
  }
}

/** Logging captured data must never break the instrumented call. */
function logSafely(
  span: Span,
  label: string,
  event: () => Record<string, unknown>,
): void {
  try {
    span.log(event());
  } catch (error) {
    debugLogger.error(`Error capturing LiveKit ${label}`, error);
  }
}

interface NodeObserverOptions {
  span: Span;
  args: LiveKitNodeArgs;
  capture: boolean;
  markContent: () => void;
}

interface NodeObserver {
  /** Called for each chunk of the node's input stream, if set. */
  onInput?: (chunk: unknown) => void;
  onOutput: (chunk: unknown) => void;
  /** Builds the final event once the output stream ends. */
  finish: () => Record<string, unknown>;
}

const NODE_OBSERVERS: Record<
  LiveKitNodeName,
  (options: NodeObserverOptions) => NodeObserver
> = {
  llmNode: observeLlmNode,
  sttNode: observeSttNode,
  ttsNode: observeTtsNode,
};

function traceNode(
  method: LiveKitNodeName,
  agent: LiveKitAgent,
  args: LiveKitNodeArgs,
  invoke: () => PromiseLike<LiveKitNodeResult>,
): PromiseLike<LiveKitNodeResult> {
  if (isAutoInstrumentationSuppressed()) return invoke();
  const span = startSpan(
    withSpanInstrumentationName(
      {
        name: `livekit.Agent.${method}`,
        spanAttributes: { type: SpanTypeAttribute.LLM },
      },
      INSTRUMENTATION_NAMES.LIVEKIT_AGENTS,
    ),
  );
  const scope = <T>(fn: () => T): T =>
    withCurrent(span, () => runWithAutoInstrumentationSuppressed(fn));
  const startTime = performance.now();
  let hasContent = false;
  const markContent = () => {
    if (hasContent) return;
    hasContent = true;
    span.log({
      metrics: { time_to_first_token: (performance.now() - startTime) / 1000 },
    });
  };

  let observer: NodeObserver | undefined;
  try {
    observer = NODE_OBSERVERS[method]({
      span,
      args,
      capture: isAutoCaptureAttachmentsEnabled(),
      markContent,
    });
    if (observer.onInput) {
      observeStream(args[0], {
        debugLabel: "LiveKit input",
        onChunk: (chunk) => observer?.onInput?.(chunk),
        onComplete() {},
        onCancel() {},
      });
    }
    const model = agent.getActivityOrThrow()[NODE_MODELS[method]];
    const provider = model?.provider;
    span.log({
      metadata: {
        model: model?.model,
        provider: provider
          ? (PROVIDERS_BY_HOST.get(provider) ?? provider)
          : undefined,
      },
    });
  } catch (error) {
    debugLogger.error("Error capturing LiveKit input", error);
  }

  let ended = false;
  const finish = (error?: unknown) => {
    if (ended) return;
    ended = true;
    if (error !== undefined) span.log({ error });
    if (observer) logSafely(span, "output", observer.finish);
    // Release captured frames, even if the input stream keeps going.
    observer = undefined;
    span.end();
  };

  let result: PromiseLike<LiveKitNodeResult>;
  try {
    result = scope(invoke);
  } catch (error) {
    finish(error);
    throw error;
  }
  void Promise.resolve(result).then((stream) => {
    if (!stream) return finish();
    try {
      observeStream(stream, {
        debugLabel: "LiveKit output",
        aroundRead: scope,
        onChunk: (chunk) => observer?.onOutput(chunk),
        onComplete: finish,
        onCancel: finish,
      });
    } catch (error) {
      debugLogger.error("Error observing LiveKit output", error);
      finish();
    }
  }, finish);
  return result;
}

function observeLlmNode({
  span,
  args,
  capture,
  markContent,
}: NodeObserverOptions): NodeObserver {
  const toolContext = args[1] as LiveKitToolContext | undefined;
  if (toolContext?.functionTools) {
    for (const tool of Object.values(toolContext.functionTools))
      instrumentTool(tool);
    span.log({
      metadata: {
        tools: liveKitToolDefinitions(toolContext),
        tool_choice: args[2]?.toolChoice,
      },
    });
  }
  const attachments = new WeakMap<object, unknown[]>();
  const messages = () =>
    liveKitMessages(args[0] as LiveKitChatContext, capture, attachments);
  span.log({ input: messages() });

  let text = "";
  const toolCalls = new Map<string, unknown>();
  const metrics: Record<string, number> = {};
  const appendText = (value: string) => {
    if (value) markContent();
    text += value;
  };
  return {
    onOutput(chunk) {
      if (typeof chunk === "string") return appendText(chunk);
      if (!isObject(chunk)) return;
      const { delta, usage } = chunk;
      if (isObject(delta)) {
        if (typeof delta.content === "string") appendText(delta.content);
        for (const call of Array.isArray(delta.toolCalls)
          ? delta.toolCalls
          : []) {
          if (!isObject(call) || typeof call.callId !== "string") continue;
          markContent();
          toolCalls.set(call.callId, {
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: call.args },
          });
        }
      }
      if (isObject(usage)) {
        for (const [source, metric] of LLM_USAGE_METRICS) {
          const value = usage[source];
          if (typeof value === "number") metrics[metric] = value;
        }
      }
    },
    finish: () => ({
      // Providers populate native image caches while consuming the request,
      // so the input is captured again once the request is done.
      input: messages(),
      output: [
        {
          message: {
            role: "assistant",
            content: text || null,
            ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}),
          },
        },
      ],
      metrics,
    }),
  };
}

function observeSttNode({
  span,
  capture,
  markContent,
}: NodeObserverOptions): NodeObserver {
  span.log({ input: { operation: "transcribe" } });
  const inputFrames: LiveKitAudioFrame[] = [];
  const segments: Record<string, unknown>[] = [];
  const metrics: Record<string, number> = {};
  let text = "";
  let language: string | undefined;
  return {
    // Input audio is only read when it will be attached.
    onInput: capture
      ? (chunk) => {
          const frame = copyLiveKitAudio(chunk);
          if (frame) inputFrames.push(frame);
        }
      : undefined,
    onOutput(chunk) {
      if (typeof chunk === "string") {
        if (chunk) markContent();
        text += chunk;
        return;
      }
      if (!isObject(chunk)) return;
      const alternative = Array.isArray(chunk.alternatives)
        ? chunk.alternatives[0]
        : undefined;
      if (
        (chunk.type === INTERIM_TRANSCRIPT ||
          chunk.type === FINAL_TRANSCRIPT) &&
        isObject(alternative) &&
        typeof alternative.text === "string"
      ) {
        if (alternative.text) markContent();
        // Only final transcripts are recorded; other events repeat their text.
        if (chunk.type === FINAL_TRANSCRIPT) {
          text += (text && alternative.text ? " " : "") + alternative.text;
          if (typeof alternative.language === "string")
            language = alternative.language;
          segments.push({
            text: alternative.text,
            start: alternative.startTime,
            end: alternative.endTime,
            confidence: alternative.confidence,
            speaker_id: alternative.speakerId,
          });
        }
      }
      if (
        chunk.type === RECOGNITION_USAGE &&
        isObject(chunk.recognitionUsage)
      ) {
        const { inputTokens, outputTokens } = chunk.recognitionUsage;
        if (typeof inputTokens === "number")
          metrics.prompt_tokens = (metrics.prompt_tokens ?? 0) + inputTokens;
        if (typeof outputTokens === "number")
          metrics.completion_tokens =
            (metrics.completion_tokens ?? 0) + outputTokens;
        if (
          metrics.prompt_tokens !== undefined &&
          metrics.completion_tokens !== undefined
        )
          metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
      }
    },
    finish: () => ({
      input: {
        operation: "transcribe",
        content: liveKitAudioParts(inputFrames),
      },
      output: {
        content: text ? [{ type: "text", text }] : [],
        annotations: { language, ...(segments.length ? { segments } : {}) },
      },
      metrics,
    }),
  };
}

function observeTtsNode({
  span,
  capture,
  markContent,
}: NodeObserverOptions): NodeObserver {
  span.log({ input: { operation: "speech" } });
  const frames: LiveKitAudioFrame[] = [];
  let prompt = "";
  return {
    onInput(chunk) {
      if (typeof chunk === "string") prompt += chunk;
    },
    onOutput(chunk) {
      if (!isObject(chunk)) return;
      // Timing only needs frame dimensions; reading audio data is opt-in.
      if (
        typeof chunk.samplesPerChannel === "number" &&
        chunk.samplesPerChannel > 0
      )
        markContent();
      if (capture) {
        const frame = copyLiveKitAudio(chunk);
        if (frame) frames.push(frame);
      }
    },
    finish: () => ({
      input: { operation: "speech", prompt },
      output: { content: liveKitAudioParts(frames) },
    }),
  };
}
