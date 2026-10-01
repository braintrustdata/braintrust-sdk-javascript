import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  LiveKitAgent,
  LiveKitNodeArgs,
  LiveKitNodeResult,
  LiveKitTool,
  LiveKitToolOptions,
} from "../../vendor-sdk-types/livekit-agents";

type DefaultNodeArgs = [LiveKitAgent, ...LiveKitNodeArgs];

export const liveKitAgentsChannels = defineChannels(
  "@livekit/agents",
  {
    sttNode: channel<LiveKitNodeArgs, LiveKitNodeResult>({
      channelName: "Agent.sttNode",
      kind: "async",
    }),
    llmNode: channel<LiveKitNodeArgs, LiveKitNodeResult>({
      channelName: "Agent.llmNode",
      kind: "async",
    }),
    ttsNode: channel<LiveKitNodeArgs, LiveKitNodeResult>({
      channelName: "Agent.ttsNode",
      kind: "async",
    }),
    defaultSttNode: channel<DefaultNodeArgs, LiveKitNodeResult>({
      channelName: "Agent.default.sttNode",
      kind: "async",
    }),
    defaultLlmNode: channel<DefaultNodeArgs, LiveKitNodeResult>({
      channelName: "Agent.default.llmNode",
      kind: "async",
    }),
    defaultTtsNode: channel<DefaultNodeArgs, LiveKitNodeResult>({
      channelName: "Agent.default.ttsNode",
      kind: "async",
    }),
    tool: channel<[LiveKitTool], LiveKitTool>({
      channelName: "llm.tool",
      kind: "sync-stream",
    }),
    executeTool: channel<
      [unknown, LiveKitToolOptions?],
      unknown,
      { name?: string }
    >({
      channelName: "tool.execute",
      kind: "sync-stream",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.LIVEKIT_AGENTS },
);
