import { channel, defineInterceptor } from "../core/channel-definitions";

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
