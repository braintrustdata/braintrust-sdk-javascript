import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";

type StagehandChannelContext = {
  self?: unknown;
};

type StagehandAgentExecuteContext = StagehandChannelContext & {
  agentConfig?: unknown;
  stagehand?: unknown;
};

export const stagehandChannels = defineChannels(
  "@browserbasehq/stagehand",
  {
    act: channel<unknown[], unknown, StagehandChannelContext>({
      channelName: "Stagehand.act",
      kind: "async",
    }),
    extract: channel<unknown[], unknown, StagehandChannelContext>({
      channelName: "Stagehand.extract",
      kind: "async",
    }),
    observe: channel<unknown[], unknown, StagehandChannelContext>({
      channelName: "Stagehand.observe",
      kind: "async",
    }),
    agent: channel<unknown[], unknown, StagehandChannelContext>({
      channelName: "Stagehand.agent",
      kind: "sync-stream",
    }),
    agentExecute: channel<unknown[], unknown, StagehandAgentExecuteContext>({
      channelName: "Agent.execute",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.STAGEHAND },
);
