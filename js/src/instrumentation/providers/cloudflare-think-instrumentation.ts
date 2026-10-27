import { withCurrent } from "../../logger/core";

import { observeResult, runInstrumentation } from "../core/observe-result";

import { SpanTypeAttribute, isObject } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import type { Span } from "../../logger/core";
import { _internalGetGlobalState, startSpan } from "../../logger/core";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import type { ChannelMessage } from "../core/tracing-types";

// Think delegates inference and tool execution to AI SDK's streamText. Its
// events keep the task open through stream consumption and provide the model,
// tool, output, and usage data that the outer Think call does not expose.
import type { AISDKResult } from "../../vendor-sdk-types/ai-sdk";
import type { CloudflareThinkMessage } from "../../vendor-sdk-types/cloudflare-think";
import { braintrustAISDKTelemetry } from "../../wrappers/ai-sdk/telemetry";
import { aiSDKChannels } from "./ai-sdk-interceptors";
import {
  DEFAULT_DENY_OUTPUT_PATHS,
  finalizeAISDKChildTracing,
  patchAISDKStreamingResult,
  patchAISDKV7TelemetryDispatcher,
  prepareAISDKAgentCallInput,
} from "./ai-sdk-instrumentation";
import { cloudflareThinkChannels } from "./cloudflare-think-interceptors";
import {
  registerCloudflareThinkSpan,
  unregisterCloudflareThinkSpan,
} from "./cloudflare-think-context";

type ThinkRunState = {
  aiEvent?: Record<string, unknown>;
  aiResultPatched: boolean;
  telemetryClaimed: boolean;
  fallbackInput?: unknown;
  finalized: boolean;
  inputLogged: boolean;
  span: Span;
  startTime: number;
};

type AISDKStreamEvent = ChannelMessage<
  typeof aiSDKChannels.streamTextSync | typeof aiSDKChannels.streamText
>;

const THINK_STATE_ID = Symbol.for("braintrust.cloudflare-think.state-id");

class CloudflareThinkInstrumentationConsumer {
  private readonly statesBySpanId = new Map<string, ThinkRunState>();

  public register(): void {
    const telemetry = braintrustAISDKTelemetry();
    this.subscribeToThinkRuns();
    this.subscribeToAISDKStreamTextSync();
    this.subscribeToAISDKStreamTextAsync();
    aiSDKChannels.v7CreateTelemetryDispatcher.intercept(
      (target, receiver, args) => {
        const dispatcher = Reflect.apply(target, receiver, args);
        if (this.currentState() && args[0]?.telemetry?.isEnabled !== false) {
          // Think must also work when the standalone AI SDK integration is
          // disabled. Dispatcher patching is shared and idempotent.
          runInstrumentation(() =>
            patchAISDKV7TelemetryDispatcher(
              dispatcher,
              telemetry,
              args[0]?.telemetry,
            ),
          );
        }
        return dispatcher;
      },
    );
    aiSDKChannels.streamTextV7.intercept((target, receiver, args) => {
      const state = this.currentState();
      const result = Reflect.apply(target, receiver, args);
      const telemetry = args[0]?.telemetry ?? args[0]?.experimental_telemetry;
      if (state && telemetry?.isEnabled !== false) {
        state.aiResultPatched = true;
      }
      return result;
    });
  }

  private subscribeToThinkRuns(): void {
    const channel = cloudflareThinkChannels.runInferenceLoop;
    const states = new WeakMap<object, ThinkRunState>();
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

      const span = startSpan(
        withSpanInstrumentationName(
          {
            name: "Think.runTurn",
            spanAttributes: { type: SpanTypeAttribute.TASK },
          },
          INSTRUMENTATION_NAMES.CLOUDFLARE_THINK,
        ),
      );
      const runState: ThinkRunState = {
        aiResultPatched: false,
        telemetryClaimed: false,
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
      registerCloudflareThinkSpan({
        span,
        startTelemetry: (input, metadata) => {
          // Only the outer inference stream owns this task. A stream started
          // inside a tool must retain its own AI SDK operation span.
          if (runState.finalized || runState.telemetryClaimed) {
            return false;
          }
          runState.telemetryClaimed = true;
          runState.aiResultPatched = true;
          runState.inputLogged = true;
          span.log({
            ...(input !== undefined
              ? { input: extractThinkTaskInput(input) }
              : {}),
            metadata: {
              ...metadata,
              braintrust: {
                integration_name: "cloudflare-think",
                sdk_language: "typescript",
              },
            },
          });
          return true;
        },
        finishTelemetry: (output, metrics, error) => {
          if (runState.finalized) {
            return;
          }
          span.log({ metrics });
          this.finishState(runState, error, output);
        },
      });
      return runState;
    };

    channel.intercept((target, receiver, args, additional) => {
      const event = {
        ...additional,
        arguments: args,
        self: receiver,
      } as ChannelMessage<typeof cloudflareThinkChannels.runInferenceLoop>;
      const prepare = (
        event: ChannelMessage<typeof cloudflareThinkChannels.runInferenceLoop>,
      ) => {
        ensureState(event);
      };
      const resolved = (
        event: ChannelMessage<typeof cloudflareThinkChannels.runInferenceLoop>,
      ) => {
        const runState = states.get(event);
        states.delete(event);
        if (!runState || runState.finalized || runState.aiResultPatched) {
          return;
        }
        this.finishState(runState, undefined, event.result);
      };
      const failed = (
        event: ChannelMessage<typeof cloudflareThinkChannels.runInferenceLoop>,
      ) => {
        const runState = states.get(event);
        states.delete(event);
        if (runState) {
          this.finishState(runState, event.error);
        }
      };
      const invoke = () => {
        runInstrumentation(() => prepare(event));
        let result;
        try {
          result = Reflect.apply(target, receiver, args);
        } catch (error) {
          Object.assign(event, { error });
          runInstrumentation(() => failed(event));
          throw error;
        }

        return observeResult(
          result,
          (value) => {
            Object.assign(event, { result: value });
            resolved(event);
          },
          (error) => {
            Object.assign(event, { error });
            failed(event);
          },
        );
      };
      const spanState = runInstrumentation(() => ensureState(event));
      return spanState ? withCurrent(spanState.span, invoke) : invoke();
    });
  }

  private subscribeToAISDKStreamTextSync(): void {
    const channel = aiSDKChannels.streamTextSync;

    channel.intercept((target, receiver, args, additional) => {
      const event = {
        ...additional,
        arguments: args,
        self: receiver,
      } as ChannelMessage<typeof aiSDKChannels.streamTextSync>;
      const prepare = (
        event: ChannelMessage<typeof aiSDKChannels.streamTextSync>,
      ) => {
        this.startAISDKStream(event);
      };
      const returned = (
        event: ChannelMessage<typeof aiSDKChannels.streamTextSync>,
      ) => {
        this.endAISDKStream(event);
      };
      const failed = (
        event: ChannelMessage<typeof aiSDKChannels.streamTextSync>,
      ) => {
        this.errorAISDKStream(event);
      };
      runInstrumentation(() => prepare(event));
      let result;
      try {
        result = Reflect.apply(target, receiver, args);
      } catch (error) {
        Object.assign(event, { error });
        runInstrumentation(() => failed(event));
        throw error;
      }
      Object.assign(event, { result });
      runInstrumentation(() => returned(event));
      return result;
    });
  }
  private subscribeToAISDKStreamTextAsync(): void {
    const channel = aiSDKChannels.streamText;

    channel.intercept((target, receiver, args, additional) => {
      const event = {
        ...additional,
        arguments: args,
        self: receiver,
      } as ChannelMessage<typeof aiSDKChannels.streamText>;
      const prepare = (
        event: ChannelMessage<typeof aiSDKChannels.streamText>,
      ) => {
        this.startAISDKStream(event);
      };
      const resolved = (
        event: ChannelMessage<typeof aiSDKChannels.streamText>,
      ) => {
        this.endAISDKStream(event);
      };
      const failed = (
        event: ChannelMessage<typeof aiSDKChannels.streamText>,
      ) => {
        this.errorAISDKStream(event);
      };
      runInstrumentation(() => prepare(event));
      let result;
      try {
        result = Reflect.apply(target, receiver, args);
      } catch (error) {
        Object.assign(event, { error });
        runInstrumentation(() => failed(event));
        throw error;
      }
      return observeResult(
        result,
        (value) => {
          Object.assign(event, { result: value });
          resolved(event);
        },
        (error) => {
          Object.assign(event, { error });
          failed(event);
        },
      );
    });
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
      _internalGetGlobalState()?.contextManager.getParentSpanIds()
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

let cloudflareThinkInstrumentationConsumer:
  | CloudflareThinkInstrumentationConsumer
  | undefined;

export function registerCloudflareThinkInstrumentation(): void {
  cloudflareThinkInstrumentationConsumer ??=
    new CloudflareThinkInstrumentationConsumer();
  cloudflareThinkInstrumentationConsumer.register();
}
