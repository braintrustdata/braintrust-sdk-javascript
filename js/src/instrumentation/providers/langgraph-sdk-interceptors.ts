import type {
  LangGraphBatchArgs,
  LangGraphJoinArgs,
  LangGraphJoinStreamArgs,
  LangGraphRunArgs,
  LangGraphStreamEvent,
} from "../../vendor-sdk-types/langgraph-sdk";
import { channel, defineInterceptor } from "../core/interceptor-definitions";

export const langGraphSDKChannels = defineInterceptor(
  "@langchain/langgraph-sdk",
  {
    create: channel<LangGraphRunArgs, PromiseLike<unknown>>({
      channelName: "runs.create",
    }),
    createBatch: channel<LangGraphBatchArgs, PromiseLike<unknown>>({
      channelName: "runs.createBatch",
    }),
    join: channel<LangGraphJoinArgs, PromiseLike<unknown>>({
      channelName: "runs.join",
    }),
    joinStream: channel<
      LangGraphJoinStreamArgs,
      AsyncGenerator<LangGraphStreamEvent>
    >({
      channelName: "runs.joinStream",
    }),
    wait: channel<LangGraphRunArgs, PromiseLike<unknown>>({
      channelName: "runs.wait",
    }),
    stream: channel<LangGraphRunArgs, AsyncGenerator<LangGraphStreamEvent>>({
      channelName: "runs.stream",
    }),
  },
);
