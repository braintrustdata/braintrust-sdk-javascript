import { channel, defineChannels } from "../core/channel-definitions";
import type {
  OpenRouterAgentCallModelArgs,
  OpenRouterAgentCallModelRequest,
} from "../../vendor-sdk-types/openrouter-agent";

export const openRouterAgentChannels = defineChannels("@openrouter/agent", {
  callModel: channel<OpenRouterAgentCallModelArgs, unknown>({
    channelName: "callModel",
    kind: "sync-stream",
  }),

  callModelTurn: channel<
    [OpenRouterAgentCallModelRequest | undefined],
    unknown,
    {
      step: number;
      stepType: "initial" | "continue";
    }
  >({
    channelName: "callModel.turn",
    kind: "async",
  }),

  toolExecute: channel<
    [unknown],
    unknown | AsyncIterable<unknown>,
    {
      span_info?: {
        name?: string;
      };
      toolCallId?: string;
      toolName: string;
    },
    unknown
  >({
    channelName: "tool.execute",
    kind: "async",
  }),
});
