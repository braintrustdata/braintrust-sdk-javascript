/* eslint-disable @typescript-eslint/consistent-type-assertions -- vendored LiveKit boundaries. */
import { debugLogger } from "../debug-logger";
import { livekitChannels } from "../instrumentation/plugins/livekit-interceptors";
import type {
  AgentActivity,
  AgentSession,
  LiveKitModule,
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
    if (activity.audioRecognition)
      wrapMethod(
        activity.audioRecognition,
        "processSTTEvent",
        livekitChannels.stt,
      );
  });
  wrapMethod(activity, "_startSessionImpl", livekitChannels.activity);
  wrapMethod(activity, "onEndOfTurn", livekitChannels.userTurn);
  wrapMethod(activity, "onStartOfSpeech", livekitChannels.speechStart);
  wrapMethod(activity, "userTurnCompleted", livekitChannels.userCompleted);
  wrapMethod(activity, "_pipelineReplyTaskImpl", livekitChannels.pipeline);
}

function wrapSession(session: AgentSession): AgentSession {
  wrapMethod(session, "_startImpl", livekitChannels.start);
  wrapMethod(session, "closeImpl", livekitChannels.close);
  // AgentActivity is not exported. LiveKit reports each new activity's handoff
  // item through _conversationItemAdded before activity.start(), so that is the
  // first call where the activity exists and none of its hooks have run yet.
  wrapMethod(
    session,
    "_conversationItemAdded",
    livekitChannels.conversation,
    () => wrapActivity(session.activity),
  );
  return session;
}

/**
 * Trace a LiveKit Agents (1.9.x) module with Braintrust.
 *
 * Captures cascade voice sessions: user and agent turns, speech, STT, LLM
 * responses, TTS and function tools. Call audio is recorded as PCM attachments
 * per direction: set BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS for caller audio
 * and BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS for agent audio. Wrap the module before constructing
 * sessions; only sessions created through the wrapped module are traced.
 *
 * @example
 * ```ts
 * import * as agents from "@livekit/agents";
 * const { voice } = wrapLiveKit(agents);
 * const session = new voice.AgentSession({ stt, llm, tts });
 * ```
 */
export function wrapLiveKit<T extends object>(module: T): T {
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
  const AgentSession = new Proxy(livekit.voice.AgentSession, {
    construct(target, args, newTarget) {
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
