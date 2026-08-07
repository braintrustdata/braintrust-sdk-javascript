import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  StagehandActArguments,
  StagehandActResult,
  StagehandAgent,
  StagehandAgentConfig,
  StagehandAgentExecuteArguments,
  StagehandAgentResult,
  StagehandAgentStreamResult,
  StagehandExtractArguments,
  StagehandInstance,
  StagehandObserveArguments,
  StagehandObserveResult,
} from "../../vendor-sdk-types/stagehand";

type StagehandChannelContext = {
  self?: StagehandInstance;
};

type StagehandAgentExecuteContext = {
  agentConfig?: StagehandAgentConfig;
  self?: StagehandAgent;
  stagehand?: StagehandInstance;
};

export const stagehandChannels = defineChannels(
  "@browserbasehq/stagehand",
  {
    act: channel<
      StagehandActArguments,
      StagehandActResult,
      StagehandChannelContext
    >({
      channelName: "Stagehand.act",
      kind: "async",
    }),
    extract: channel<
      StagehandExtractArguments,
      unknown,
      StagehandChannelContext
    >({
      channelName: "Stagehand.extract",
      kind: "async",
    }),
    observe: channel<
      StagehandObserveArguments,
      StagehandObserveResult,
      StagehandChannelContext
    >({
      channelName: "Stagehand.observe",
      kind: "async",
    }),
    agent: channel<
      [config?: StagehandAgentConfig],
      StagehandAgent,
      StagehandChannelContext
    >({
      channelName: "Stagehand.agent",
      kind: "sync-stream",
    }),
    agentExecute: channel<
      StagehandAgentExecuteArguments,
      StagehandAgentResult | StagehandAgentStreamResult,
      StagehandAgentExecuteContext
    >({
      channelName: "Agent.execute",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.STAGEHAND },
);
