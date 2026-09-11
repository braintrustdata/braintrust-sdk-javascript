import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  LangGraphRunArgs,
  LangGraphStreamEvent,
} from "../../vendor-sdk-types/langgraph-sdk";
import { channel, defineChannels } from "../core/channel-definitions";

export const langGraphSDKChannels = defineChannels(
  "@langchain/langgraph-sdk",
  {
    wait: channel<LangGraphRunArgs, unknown>({
      channelName: "runs.wait",
      kind: "async",
    }),
    stream: channel<LangGraphRunArgs, AsyncGenerator<LangGraphStreamEvent>>({
      channelName: "runs.stream",
      kind: "sync-stream",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.LANGGRAPH_SDK },
);
