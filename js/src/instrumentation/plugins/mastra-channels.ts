import { channel, defineChannels } from "../core/channel-definitions";
import type {
  MastraAgentExecuteOptions,
  MastraAgentNetworkOptions,
  MastraToolContext,
  MastraWorkflowRestartArgs,
  MastraWorkflowResumeArgs,
  MastraWorkflowStartArgs,
  MastraWorkflowStepParams,
} from "../../vendor-sdk-types/mastra";

export const mastraChannels = defineChannels("@mastra/core", {
  agentExecute: channel<[MastraAgentExecuteOptions], unknown>({
    channelName: "agent.execute",
    kind: "async",
  }),

  agentNetwork: channel<[unknown, MastraAgentNetworkOptions?], unknown>({
    channelName: "agent.network",
    kind: "async",
  }),

  agentResumeNetwork: channel<[unknown, MastraAgentNetworkOptions?], unknown>({
    channelName: "agent.resumeNetwork",
    kind: "async",
  }),

  agentGenerateLegacy: channel<[unknown, Record<string, unknown>?], unknown>({
    channelName: "agent.generateLegacy",
    kind: "async",
  }),

  agentStreamLegacy: channel<[unknown, Record<string, unknown>?], unknown>({
    channelName: "agent.streamLegacy",
    kind: "async",
  }),

  toolExecute: channel<[unknown, MastraToolContext?], unknown>({
    channelName: "tool.execute",
    kind: "async",
  }),

  workflowRunStart: channel<[MastraWorkflowStartArgs?], unknown>({
    channelName: "workflow.run.start",
    kind: "async",
  }),

  workflowRunResume: channel<[MastraWorkflowResumeArgs?], unknown>({
    channelName: "workflow.run.resume",
    kind: "async",
  }),

  workflowRunRestart: channel<[MastraWorkflowRestartArgs?], unknown>({
    channelName: "workflow.run.restart",
    kind: "async",
  }),

  workflowStepExecute: channel<
    [string, unknown, MastraWorkflowStepParams?],
    unknown
  >({
    channelName: "workflow.step.execute",
    kind: "async",
  }),
});
