import { channel, defineInterceptor } from "../core/interceptor-definitions";
import type {
  CompleteAISDKBatchTraceArgs,
  StartAISDKBatchTraceArgs,
} from "../../vendor-sdk-types/ai-sdk-batch";

/** Explicit capture hooks only; no provider lifecycle methods invoke these. */
export const aiSDKBatchChannels = defineInterceptor("ai", {
  start: channel<[StartAISDKBatchTraceArgs], Promise<string | undefined>>({
    channelName: "batch.startTrace",
  }),
  complete: channel<[CompleteAISDKBatchTraceArgs], Promise<void>>({
    channelName: "batch.completeTrace",
  }),
});
