import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  OpenRouterAgentCallModelArgs,
  OpenRouterAgentCallModelRequest,
} from "../../vendor-sdk-types/openrouter-agent";

export const openRouterAgentChannels = defineInterceptor("@openrouter/agent", {
  callModel: channel<OpenRouterAgentCallModelArgs, unknown>({
    channelName: "callModel",
  }),

  callModelTurn: channel<
    [OpenRouterAgentCallModelRequest | undefined],
    PromiseLike<unknown>,
    {
      step: number;
      stepType: "initial" | "continue";
    }
  >({
    channelName: "callModel.turn",
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
  }),
});
