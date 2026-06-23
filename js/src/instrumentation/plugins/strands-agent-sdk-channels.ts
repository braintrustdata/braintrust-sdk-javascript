import { channel, defineChannels } from "../core/channel-definitions";
import type {
  StrandsAgent,
  StrandsAgentResult,
  StrandsAgentStreamEvent,
  StrandsInvokeArgs,
  StrandsInvokeOptions,
  StrandsMultiAgent,
  StrandsMultiAgentInput,
  StrandsMultiAgentInvokeOptions,
  StrandsMultiAgentResult,
  StrandsMultiAgentStreamEvent,
} from "../../vendor-sdk-types/strands-agent-sdk";

type StrandsChannelContext = {
  self?: unknown;
};

export const strandsAgentSDKChannels = defineChannels("@strands-agents/sdk", {
  agentStream: channel<
    [StrandsInvokeArgs, StrandsInvokeOptions | undefined],
    AsyncGenerator<StrandsAgentStreamEvent, StrandsAgentResult, undefined>,
    StrandsChannelContext & { agent?: StrandsAgent },
    StrandsAgentStreamEvent
  >({
    channelName: "Agent.stream",
    kind: "sync-stream",
  }),

  graphStream: channel<
    [StrandsMultiAgentInput, StrandsMultiAgentInvokeOptions | undefined],
    AsyncGenerator<
      StrandsMultiAgentStreamEvent,
      StrandsMultiAgentResult,
      undefined
    >,
    StrandsChannelContext & { orchestrator?: StrandsMultiAgent },
    StrandsMultiAgentStreamEvent
  >({
    channelName: "Graph.stream",
    kind: "sync-stream",
  }),

  swarmStream: channel<
    [StrandsMultiAgentInput, StrandsMultiAgentInvokeOptions | undefined],
    AsyncGenerator<
      StrandsMultiAgentStreamEvent,
      StrandsMultiAgentResult,
      undefined
    >,
    StrandsChannelContext & { orchestrator?: StrandsMultiAgent },
    StrandsMultiAgentStreamEvent
  >({
    channelName: "Swarm.stream",
    kind: "sync-stream",
  }),
});
