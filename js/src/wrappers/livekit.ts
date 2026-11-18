import { registerInstrumentation } from "../instrumentation/registrations/livekit";
/* eslint-disable @typescript-eslint/consistent-type-assertions -- vendored LiveKit boundaries. */
import { debugLogger } from "../debug-logger";
import {
  livekitChannels,
  livekitOpenAIChannels,
} from "../instrumentation/providers/livekit-interceptors";
import type {
  AgentActivity,
  AgentSession,
  LiveKitModule,
  LiveKitOpenAIPlugin,
} from "../vendor-sdk-types/livekit";

const wrapped = Symbol.for("braintrust.livekit.wrapped");

function wrapMethod<Args extends unknown[], Result>(
  target: object,
  name: string,
  hook: {
    invoke(
      target: (...args: Args) => Result,
      receiver: unknown,
      args: Args,
      additional: object,
    ): Result;
  },
  before?: () => void,
) {
  const methods = target as Record<string, unknown>;
  const original = methods[name];
  if (typeof original !== "function" || Reflect.get(original, wrapped)) return;
  const invoke = original as (...args: Args) => Result;
  const fn = function (this: unknown, ...args: Args): Result {
    before?.();
    return hook.invoke(invoke, this, args, {});
  };
  Object.defineProperty(fn, wrapped, { value: true });
  methods[name] = fn;
}

function wrapActivity(activity: AgentActivity | undefined) {
  if (!activity) return;
  if (activity.agent) {
    wrapMethod(activity.agent, "llmNode", livekitChannels.inference);
    wrapMethod(activity.agent, "ttsNode", livekitChannels.inference);
  }
  // The recognizer exists once the activity starts, before it receives audio.
  wrapMethod(activity, "attachAudioInput", livekitChannels.input, () => {
    if (activity.audioRecognition) {
      wrapMethod(
        activity.audioRecognition,
        "close",
        livekitChannels.recognitionClose,
      );
      wrapMethod(
        activity.audioRecognition,
        "ensureEouWaitSpan",
        livekitChannels.eouWait,
      );
      wrapMethod(
        activity.audioRecognition,
        "runEOUDetection",
        livekitChannels.eouEvaluation,
      );
      wrapMethod(
        activity.audioRecognition,
        "endEouWaitSpan",
        livekitChannels.eouEnd,
      );
      wrapMethod(
        activity.audioRecognition,
        "processSTTEvent",
        livekitChannels.stt,
      );
    }
  });
  wrapMethod(activity, "_startSessionImpl", livekitChannels.activity);
  wrapMethod(activity, "onEndOfTurn", livekitChannels.userTurn);
  wrapMethod(activity, "onStartOfSpeech", livekitChannels.speechStart);
  wrapMethod(activity, "onEndOfSpeech", livekitChannels.speechEnd);
  wrapMethod(activity, "onVADInferenceDone", livekitChannels.vadInference);
  wrapMethod(activity, "userTurnCompleted", livekitChannels.userCompleted);
  wrapMethod(activity, "_pipelineReplyTaskImpl", livekitChannels.pipeline);
}

function wrapSession(session: AgentSession): AgentSession {
  wrapMethod(session, "_startImpl", livekitChannels.start);
  wrapMethod(session, "closeImpl", livekitChannels.close);
  // The public conversation_item_added event reports handoffs before the new
  // activity starts. Observe emit rather than the private insertion helper so
  // automatic and manual entrypoints share the same public event boundary.
  wrapMethod(session, "emit", livekitChannels.sessionEvent, () =>
    wrapActivity(session.activity),
  );
  return session;
}

/** Mechanical constructor hooks; actual client ownership is recorded by the plugin. */
function wrapOpenAIPlugin<T extends object>(
  module: T,
  plugin: LiveKitOpenAIPlugin,
): T {
  const constructors = new Map<PropertyKey, unknown>();
  for (const [kind, name] of [
    ["llm", "LLM"],
    ["stt", "STT"],
    ["tts", "TTS"],
  ] as const) {
    const original = plugin[name];
    if (Reflect.get(original, wrapped)) {
      constructors.set(name, original);
      continue;
    }
    const proxy = new Proxy(original, {
      construct(target, args, newTarget) {
        return livekitOpenAIChannels[kind].invoke(
          (...forwarded) => Reflect.construct(target, forwarded, newTarget),
          target,
          args,
          {},
        );
      },
      get(target, key, receiver) {
        if (key === wrapped) return true;
        // Static factories close over the original constructor. Observe their
        // public options and result through the same construction channel too.
        const value = Reflect.get(target, key, receiver);
        if (
          typeof key !== "string" ||
          !key.startsWith("with") ||
          typeof value !== "function"
        )
          return value;
        return (...args: unknown[]) =>
          livekitOpenAIChannels[kind].invoke(
            (...forwarded) => Reflect.apply(value, target, forwarded),
            target,
            args,
            {},
          );
      },
    });
    constructors.set(name, proxy);
  }
  return new Proxy(module, {
    get(target, key, receiver) {
      return constructors.has(key)
        ? constructors.get(key)
        : Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Trace a LiveKit Agents (1.9.x–1.10.x) module with Braintrust.
 *
 * Captures cascade voice sessions: user and agent turns, speech, STT, LLM
 * responses, TTS and function tools. Call audio is recorded as attachments per
 * direction: set BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS for caller audio and
 * BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS for agent audio. Recordings are
 * Ogg Opus when @braintrust/audio is installed, and raw PCM otherwise. Wrap the module before constructing
 * sessions; only sessions created through the wrapped module are traced.
 * Also wrap the `@livekit/agents-plugin-openai` module before constructing its
 * cascade adapters, so SDK ownership is observed through public client options.
 * Enable/wrap the OpenAI integration alongside LiveKit for OpenAI SDK model spans.
 *
 * @example
 * ```ts
 * import * as agents from "@livekit/agents";
 * const { voice } = wrapLiveKit(agents);
 * const openai = wrapLiveKit(await import("@livekit/agents-plugin-openai"));
 * const client = wrapOpenAI(new OpenAI());
 * const session = new voice.AgentSession({ stt: new openai.STT({ client }), llm, tts });
 * ```
 */
export function wrapLiveKit<T extends object>(module: T): T {
  registerInstrumentation();
  const plugin = module as unknown as Partial<LiveKitOpenAIPlugin> | undefined;
  if (
    plugin &&
    typeof plugin.LLM === "function" &&
    typeof plugin.STT === "function" &&
    typeof plugin.TTS === "function"
  )
    return wrapOpenAIPlugin(module, plugin as LiveKitOpenAIPlugin);
  const livekit = module as unknown as Partial<LiveKitModule> | undefined;
  if (
    !livekit ||
    typeof livekit !== "object" ||
    typeof livekit.voice?.AgentSession !== "function" ||
    !livekit.telemetry?.tracer
  ) {
    debugLogger.warn("Unsupported LiveKit module. Not wrapping.");
    return module;
  }
  const tracer = livekit.telemetry.tracer;
  wrapMethod(tracer, "startSpan", livekitChannels.startSpan);
  wrapMethod(tracer, "startActiveSpan", livekitChannels.startActiveSpan);
  wrapMethod(
    tracer,
    "startActiveSpanSync",
    livekitChannels.startActiveSpanSync,
  );
  const { getJobContext } = livekit;
  const AgentSession = new Proxy(livekit.voice.AgentSession, {
    construct(target, args, newTarget) {
      // LiveKit's internals call their own getJobContext, which a module proxy
      // can't intercept; hand the public export to the plugin instead.
      if (typeof getJobContext === "function")
        livekitChannels.jobContext.invoke(getJobContext, livekit, [false], {});
      return wrapSession(
        Reflect.construct(target, args, newTarget) as AgentSession,
      );
    },
  });
  const voice = new Proxy(livekit.voice, {
    get(target, key, receiver) {
      return key === "AgentSession"
        ? AgentSession
        : Reflect.get(target, key, receiver);
    },
  });
  return new Proxy(module, {
    get(target, key, receiver) {
      return key === "voice" ? voice : Reflect.get(target, key, receiver);
    },
  });
}
