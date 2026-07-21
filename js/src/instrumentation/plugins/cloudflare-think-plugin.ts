import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers } from "../../isomorph";
import {
  BRAINTRUST_CURRENT_SPAN_STORE,
  _internalGetGlobalState,
  startSpan,
} from "../../logger";
import type { CurrentSpanStore, Span } from "../../logger";
import { debugLogger } from "../../debug-logger";
import { getCurrentUnixTimestamp } from "../../util";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";

// Think delegates inference and tool execution to AI SDK's streamText. Its
// events keep the task open through stream consumption and provide the model,
// tool, output, and usage data that the outer Think call does not expose.
import { aiSDKChannels } from "./ai-sdk-channels";
import {
  DEFAULT_DENY_OUTPUT_PATHS,
  finalizeAISDKChildTracing,
  patchAISDKStreamingResult,
  prepareAISDKAgentCallInput,
} from "./ai-sdk-plugin";
import { cloudflareThinkChannels } from "./cloudflare-think-channels";
import {
  registerCloudflareThinkSpan,
  unregisterCloudflareThinkSpan,
} from "./cloudflare-think-context";
import type { AISDKResult } from "../../vendor-sdk-types/ai-sdk";
import type { CloudflareThinkMessage } from "../../vendor-sdk-types/cloudflare-think";

type ThinkRunState = {
  aiEvent?: Record<string, unknown>;
  aiResultPatched: boolean;
  fallbackInput?: unknown;
  finalized: boolean;
  inputLogged: boolean;
  span: Span;
  startTime: number;
};

type AISDKStreamEvent =
  | ChannelMessage<typeof aiSDKChannels.streamText>
  | ChannelMessage<typeof aiSDKChannels.streamTextSync>;

const THINK_STATE_ID = Symbol.for("braintrust.cloudflare-think.state-id");

export class CloudflareThinkPlugin extends BasePlugin {
  private readonly statesBySpanId = new Map<string, ThinkRunState>();

  protected onEnable(): void {
    this.subscribeToThinkRuns();
    this.subscribeToAISDKStreamTextSync();
    this.subscribeToAISDKStreamTextAsync();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];

    for (const state of this.statesBySpanId.values()) {
      this.finishState(state);
    }
    this.statesBySpanId.clear();
  }

  private subscribeToThinkRuns(): void {
    const channel = cloudflareThinkChannels.runInferenceLoop.tracingChannel();
    const states = new WeakMap<object, ThinkRunState>();
    const state = _internalGetGlobalState();
    const contextManager = state.contextManager;
    const currentSpanStore = (
      contextManager as {
        [BRAINTRUST_CURRENT_SPAN_STORE]?: CurrentSpanStore;
      }
    )[BRAINTRUST_CURRENT_SPAN_STORE];

    const ensureState = (
      event: ChannelMessage<typeof cloudflareThinkChannels.runInferenceLoop>,
    ): ThinkRunState | undefined => {
      if (isAutoInstrumentationSuppressed()) {
        return undefined;
      }
      const existing = states.get(event);
      if (existing) {
        return existing;
      }

      const span = startSpan({
        name: "Think.runTurn",
        spanAttributes: { type: SpanTypeAttribute.TASK },
      });
      const runState: ThinkRunState = {
        aiResultPatched: false,
        fallbackInput: extractFallbackInput(event.self?.messages),
        finalized: false,
        inputLogged: false,
        span,
        startTime: getCurrentUnixTimestamp(),
      };
      const metadata: Record<string, unknown> = {
        braintrust: {
          integration_name: "cloudflare-think",
          sdk_language: "typescript",
        },
      };
      if (typeof event.moduleVersion === "string") {
        metadata["cloudflare_think.version"] = event.moduleVersion;
      }
      span.log({ metadata });
      states.set(event, runState);
      if (span.spanId) {
        this.statesBySpanId.set(span.spanId, runState);
      }
      registerCloudflareThinkSpan(span);
      return runState;
    };

    if (currentSpanStore && channel.start) {
      channel.start.bindStore(currentSpanStore, (event) => {
        const runState = ensureState(event);
        return runState
          ? contextManager.wrapSpanForStore(runState.span)
          : currentSpanStore.getStore();
      });
      this.unsubscribers.push(() =>
        channel.start?.unbindStore(currentSpanStore),
      );
    }

    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof cloudflareThinkChannels.runInferenceLoop>
    > = {
      start: (event) => {
        ensureState(event);
      },
      asyncEnd: (event) => {
        const runState = states.get(event);
        states.delete(event);
        if (!runState || runState.finalized || runState.aiResultPatched) {
          return;
        }
        this.finishState(runState, undefined, event.result);
      },
      error: (event) => {
        const runState = states.get(event);
        states.delete(event);
        if (runState) {
          this.finishState(runState, event.error);
        }
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => channel.unsubscribe(handlers));
  }

  private subscribeToAISDKStreamTextSync(): void {
    const channel = aiSDKChannels.streamTextSync.tracingChannel();
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof aiSDKChannels.streamTextSync>
    > = {
      start: (event) => {
        this.startAISDKStream(event);
      },
      end: (event) => {
        this.endAISDKStream(event);
      },
      error: (event) => {
        this.errorAISDKStream(event);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => channel.unsubscribe(handlers));
  }

  private subscribeToAISDKStreamTextAsync(): void {
    const channel = aiSDKChannels.streamText.tracingChannel();
    const handlers: IsoChannelHandlers<
      ChannelMessage<typeof aiSDKChannels.streamText>
    > = {
      start: (event) => {
        this.startAISDKStream(event);
      },
      asyncEnd: (event) => {
        this.endAISDKStream(event);
      },
      error: (event) => {
        this.errorAISDKStream(event);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => channel.unsubscribe(handlers));
  }

  private startAISDKStream(event: AISDKStreamEvent): void {
    const runState = this.currentState();
    if (!runState || runState.finalized) {
      return;
    }

    try {
      const prepared = prepareAISDKAgentCallInput(
        event.arguments[0],
        event,
        runState.span,
      );
      runState.span.log({
        input: extractThinkTaskInput(prepared.input),
        metadata: {
          ...prepared.metadata,
          braintrust: {
            integration_name: "cloudflare-think",
            sdk_language: "typescript",
          },
        },
      });
      runState.inputLogged = true;
      runState.aiEvent = event;
      Reflect.set(event, THINK_STATE_ID, runState.span.spanId);
    } catch (error) {
      debugLogger.error(
        "Error preparing @cloudflare/think AI SDK tracing:",
        error,
      );
    }
  }

  private endAISDKStream(event: AISDKStreamEvent): void {
    const runState = this.stateForAISDKEvent(event);
    if (!runState || runState.finalized) {
      return;
    }

    const patched = patchAISDKStreamingResult({
      defaultDenyOutputPaths: DEFAULT_DENY_OUTPUT_PATHS,
      endEvent: event,
      forceTopLevelMetrics: true,
      onComplete: () => this.releaseState(runState),
      result: event.result as AISDKResult,
      span: runState.span,
      startTime: runState.startTime,
      transformOutput: extractThinkTaskOutput,
    });
    runState.aiResultPatched = patched;
    if (!patched) {
      this.finishState(runState, undefined, event.result);
    }
  }

  private errorAISDKStream(event: AISDKStreamEvent): void {
    const runState = this.stateForAISDKEvent(event);
    if (runState) {
      this.finishState(runState, event.error);
    }
  }

  private currentState(): ThinkRunState | undefined {
    const parentIds =
      _internalGetGlobalState().contextManager.getParentSpanIds()
        ?.spanParents ?? [];
    for (const parentId of parentIds) {
      const state = this.statesBySpanId.get(parentId);
      if (state) {
        return state;
      }
    }
    return undefined;
  }

  private stateForAISDKEvent(event: object): ThinkRunState | undefined {
    const spanId = Reflect.get(event, THINK_STATE_ID);
    return typeof spanId === "string"
      ? this.statesBySpanId.get(spanId)
      : undefined;
  }

  private finishState(
    state: ThinkRunState,
    error?: unknown,
    output?: unknown,
  ): void {
    if (state.finalized) {
      return;
    }
    state.finalized = true;
    try {
      if (!state.inputLogged && state.fallbackInput !== undefined) {
        state.span.log({ input: state.fallbackInput });
      }
      if (error !== undefined) {
        state.span.log({ error });
      } else if (output !== undefined) {
        state.span.log({ output: extractThinkTaskOutput(output) });
      }
      finalizeAISDKChildTracing(state.aiEvent);
      state.span.end();
    } finally {
      this.releaseState(state);
    }
  }

  private releaseState(state: ThinkRunState): void {
    state.finalized = true;
    unregisterCloudflareThinkSpan(state.span);
    if (state.span.spanId) {
      this.statesBySpanId.delete(state.span.spanId);
    }
  }
}

function extractFallbackInput(
  messages: CloudflareThinkMessage[] | undefined,
): unknown {
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const selected = latestUserIndex >= 0 ? messages.slice(latestUserIndex) : [];
  return selected.map((message) => ({
    role: message.role,
    content: message.content ?? message.parts,
  }));
}

function extractThinkTaskOutput(output: unknown): unknown {
  if (!isObject(output)) {
    return output;
  }
  if (typeof output.text === "string") {
    return { role: "assistant", content: output.text };
  }
  if (output.object !== undefined) {
    return output.object;
  }
  return output;
}

function extractThinkTaskInput(input: unknown): unknown {
  if (!isObject(input)) {
    return input;
  }

  const system = input.instructions ?? input.system;
  if (Array.isArray(input.messages)) {
    return system === undefined
      ? input.messages
      : [{ role: "system", content: system }, ...input.messages];
  }
  if (Array.isArray(input.prompt)) {
    return system === undefined
      ? input.prompt
      : [{ role: "system", content: system }, ...input.prompt];
  }
  if (typeof input.prompt === "string") {
    const messages = [{ role: "user", content: input.prompt }];
    return system === undefined
      ? messages
      : [{ role: "system", content: system }, ...messages];
  }
  return input;
}
