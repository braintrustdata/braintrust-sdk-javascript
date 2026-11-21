import { channel, defineInterceptor } from "../core/interceptor-definitions";

export const agentKitChannels = defineInterceptor("@inngest/agent-kit", {
  agentRun: channel<[input: unknown, options?: unknown], PromiseLike<unknown>>({
    channelName: "Agent.run",
  }),
  networkRun: channel<
    [input: unknown, options?: unknown],
    PromiseLike<unknown>
  >({ channelName: "Network.run" }),
  infer: channel<
    [stepId: string, input: unknown, tools: unknown, toolChoice: unknown],
    PromiseLike<unknown>
  >({ channelName: "AgenticModel.infer" }),
  route: channel<[input: unknown, router?: unknown], PromiseLike<unknown>>({
    channelName: "NetworkRun.getNextAgents",
  }),
  createTool: channel<[options: unknown], unknown>({
    channelName: "createTool",
  }),
  prepareTools: channel<unknown[], PromiseLike<unknown>>({
    channelName: "Agent.invokeTools",
  }),
  tool: channel<
    [input: unknown, context?: unknown],
    unknown,
    { toolName?: string }
  >({
    channelName: "tool.handler",
  }),
});
