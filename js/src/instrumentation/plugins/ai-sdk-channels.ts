import { channel, defineChannels } from "../core/channel-definitions";
import type { ChannelSpanInfo } from "../core/types";
import type {
  AISDK,
  AISDKCallParams,
  AISDKResult,
} from "../../vendor-sdk-types/ai-sdk";

type AISDKStreamResult = AISDKResult | AsyncIterable<unknown>;
type AISDKChannelContext = {
  aiSDK?: AISDK;
  denyOutputPaths?: string[];
  self?: unknown;
  span_info?: ChannelSpanInfo;
};

export const aiSDKChannels = defineChannels("ai", {
  generateText: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "generateText",
    kind: "async",
  }),
  streamText: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamText",
    kind: "async",
  }),
  streamTextSync: channel<
    [AISDKCallParams],
    AISDKResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamText.sync",
    kind: "sync-stream",
  }),
  generateObject: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "generateObject",
    kind: "async",
  }),
  streamObject: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamObject",
    kind: "async",
  }),
  streamObjectSync: channel<
    [AISDKCallParams],
    AISDKResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "streamObject.sync",
    kind: "sync-stream",
  }),
  agentGenerate: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "Agent.generate",
    kind: "async",
  }),
  agentStream: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "Agent.stream",
    kind: "async",
  }),
  toolLoopAgentGenerate: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "ToolLoopAgent.generate",
    kind: "async",
  }),
  toolLoopAgentStream: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    AISDKChannelContext,
    unknown
  >({
    channelName: "ToolLoopAgent.stream",
    kind: "async",
  }),
});
