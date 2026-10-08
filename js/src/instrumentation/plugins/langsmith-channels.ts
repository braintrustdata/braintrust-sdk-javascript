import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  LangSmithBatchIngestRuns,
  LangSmithClient,
  LangSmithRun,
} from "../../vendor-sdk-types/langsmith";

export const langSmithChannels = defineInterceptor("langsmith", {
  createRun: channel<
    [run: LangSmithRun, options?: unknown],
    PromiseLike<Awaited<ReturnType<NonNullable<LangSmithClient["createRun"]>>>>
  >({
    channelName: "Client.createRun",
  }),
  updateRun: channel<
    [runId: string, run: LangSmithRun, options?: unknown],
    PromiseLike<Awaited<ReturnType<NonNullable<LangSmithClient["updateRun"]>>>>
  >({
    channelName: "Client.updateRun",
  }),
  batchIngestRuns: channel<
    [runs: LangSmithBatchIngestRuns, options?: unknown],
    PromiseLike<
      Awaited<ReturnType<NonNullable<LangSmithClient["batchIngestRuns"]>>>
    >
  >({
    channelName: "Client.batchIngestRuns",
  }),
});
