import type {
  LangGraphRunArgs,
  LangGraphStreamEvent,
} from "../../vendor-sdk-types/langgraph-sdk";
import { channel, defineInterceptor } from "../core/channel-definitions";

export const langGraphSDKChannels = defineInterceptor(
  "@langchain/langgraph-sdk",
  {
    wait: channel<LangGraphRunArgs, PromiseLike<unknown>>({
      channelName: "runs.wait",
    }),
    stream: channel<LangGraphRunArgs, AsyncGenerator<LangGraphStreamEvent>>({
      channelName: "runs.stream",
    }),
  },
);
