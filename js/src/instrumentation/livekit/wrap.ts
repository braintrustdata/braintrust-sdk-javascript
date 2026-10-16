/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
import type { AudioFrame, ChatMessage, EndOfTurnInfo } from "./types";
import { livekitChannels } from "../plugins/livekit-channels";

const wrapped = Symbol.for("braintrust.livekit.wrapped");
function method(
  target: any,
  name: string,
  channel: Exclude<keyof typeof livekitChannels, "trace" | "provider">,
  before?: () => void,
  receiver?: object,
) {
  const original = target[name];
  if (typeof original !== "function" || original[wrapped]) return;
  const fn = function (this: unknown, ...args: unknown[]) {
    before?.();
    const self = receiver ?? this;
    if (channel === "inference")
      return livekitChannels.inference.invoke(original, self, args, {});
    if (channel === "conversation")
      return livekitChannels.conversation.invoke(
        original,
        self,
        args as [ChatMessage],
        {},
      );
    if (channel === "input")
      return livekitChannels.input.invoke(
        original,
        self,
        args as [ReadableStream<AudioFrame>],
        {},
      );
    if (channel === "userCompleted")
      return livekitChannels.userCompleted.invoke(
        original,
        self,
        args as [EndOfTurnInfo, unknown?],
        {},
      );
    if (channel === "userTurn")
      return livekitChannels.userTurn.invoke(
        original,
        self,
        args as [EndOfTurnInfo],
        {},
      );
    if (channel === "output") {
      return livekitChannels[channel].invoke(original, self, args, {});
    }
    return livekitChannels[channel].invoke(original, self, args, {});
  };
  Object.defineProperty(fn, wrapped, { value: true });
  target[name] = fn;
}
/** Wrap a LiveKit 1.9.x AgentSession before start when the Node loader cannot be used. */
export function wrapLiveKitSession<T extends object>(session: T): T {
  const target = session as any;
  if (
    typeof target._startImpl !== "function" ||
    typeof target._conversationItemAdded !== "function"
  ) {
    throw new TypeError("Expected a LiveKit 1.9.x AgentSession");
  }
  method(target, "_startImpl", "start");
  method(target, "closeImpl", "close");
  method(target, "onAudioOutputChanged", "output");
  // AgentOutput saves the callback during construction, before manual wrapping.
  if (target.output)
    method(target.output, "audioChanged", "output", undefined, target);
  // Native handoff inserts a conversation item after assigning the next activity,
  // before it starts or attaches input. Use that lifecycle for each new activity.
  method(target, "_conversationItemAdded", "conversation", () => {
    const activity = target.activity;
    if (!activity) return;
    // Without a loader, wrap the node entrypoints that start provider work.
    if (activity.agent) {
      method(activity.agent, "llmNode", "inference");
      method(activity.agent, "ttsNode", "inference");
    }
    for (const [name, channel] of [
      ["attachAudioInput", "input"],
      ["_startSessionImpl", "activity"],
      ["onEndOfTurn", "userTurn"],
      ["userTurnCompleted", "userCompleted"],
      ["_realtimeGenerationTaskImpl", "realtime"],
      ["_pipelineReplyTaskImpl", "pipeline"],
    ] as const)
      method(activity, name, channel);
  });
  return session;
}
