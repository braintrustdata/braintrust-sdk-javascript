import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  CursorSDKAgent,
  CursorSDKAgentOptions,
  CursorSDKRun,
  CursorSDKRunResult,
  CursorSDKSendOptions,
  CursorSDKUserMessage,
} from "../../vendor-sdk-types/cursor-sdk";

export const cursorSDKChannels = defineChannels(
  "@cursor/sdk",
  {
    create: channel<
      [CursorSDKAgentOptions],
      CursorSDKAgent,
      Record<string, never>
    >({
      channelName: "Agent.create",
      kind: "async",
    }),
    resume: channel<
      [string, Partial<CursorSDKAgentOptions> | undefined],
      CursorSDKAgent,
      Record<string, never>
    >({
      channelName: "Agent.resume",
      kind: "async",
    }),
    prompt: channel<
      [string | CursorSDKUserMessage, CursorSDKAgentOptions | undefined],
      CursorSDKRunResult,
      Record<string, never>
    >({
      channelName: "Agent.prompt",
      kind: "async",
    }),
    send: channel<
      [string | CursorSDKUserMessage, CursorSDKSendOptions | undefined],
      CursorSDKRun,
      {
        agent?: CursorSDKAgent;
        operation?: "send";
      }
    >({
      channelName: "agent.send",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.CURSOR_SDK },
);
