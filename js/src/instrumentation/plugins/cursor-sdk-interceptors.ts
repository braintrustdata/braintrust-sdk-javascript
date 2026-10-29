import { channel, defineInterceptor } from "../core/interceptor-definitions";

import type {
  CursorSDKAgent,
  CursorSDKAgentOptions,
  CursorSDKRun,
  CursorSDKRunResult,
  CursorSDKSendOptions,
  CursorSDKUserMessage,
} from "../../vendor-sdk-types/cursor-sdk";

export const cursorSDKChannels = defineInterceptor("@cursor/sdk", {
  create: channel<[CursorSDKAgentOptions], PromiseLike<CursorSDKAgent>, object>(
    {
      channelName: "Agent.create",
    },
  ),
  resume: channel<
    [string, Partial<CursorSDKAgentOptions> | undefined],
    PromiseLike<CursorSDKAgent>,
    object
  >({
    channelName: "Agent.resume",
  }),
  prompt: channel<
    [string | CursorSDKUserMessage, CursorSDKAgentOptions | undefined],
    PromiseLike<CursorSDKRunResult>,
    object
  >({
    channelName: "Agent.prompt",
  }),
  send: channel<
    [string | CursorSDKUserMessage, CursorSDKSendOptions | undefined],
    PromiseLike<CursorSDKRun>,
    {
      agent?: CursorSDKAgent;
      operation?: "send";
    }
  >({
    channelName: "agent.send",
  }),
});

// Shared by manual wrappers and automatic factory hooks. This patch only invokes
// wrapping hooks and remains safe when tracing is disabled.
export function patchCursorAgentInPlace(agent: unknown): void {
  if (!agent || typeof agent !== "object") return;
  const candidate = agent as CursorSDKAgent;
  const marker = Symbol.for("braintrust.cursor-sdk.auto-patched-agent");
  if (candidate[marker] || typeof candidate.send !== "function") return;
  const send = candidate.send;
  if (!Object.isExtensible(candidate)) return;
  try {
    Object.defineProperty(candidate, "send", {
      configurable: true,
      writable: true,
      value(...args: Parameters<CursorSDKAgent["send"]>) {
        return cursorSDKChannels.send.invoke(send, candidate, args, {
          agent: candidate,
          operation: "send",
        });
      },
    });
    Object.defineProperty(candidate, marker, { value: true });
  } catch {
    // A non-writable send method must not prevent use of the agent.
  }
}
