import { channel, defineChannels } from "../core/channel-definitions";
import type {
  LangSmithBatchIngestRuns,
  LangSmithClient,
  LangSmithRun,
} from "../../vendor-sdk-types/langsmith";

export const langSmithChannels = defineChannels("langsmith", {
  createRun: channel<
    [run: LangSmithRun, options?: unknown],
    Awaited<ReturnType<NonNullable<LangSmithClient["createRun"]>>>
  >({
    channelName: "Client.createRun",
    kind: "async",
  }),
  updateRun: channel<
    [runId: string, run: LangSmithRun, options?: unknown],
    Awaited<ReturnType<NonNullable<LangSmithClient["updateRun"]>>>
  >({
    channelName: "Client.updateRun",
    kind: "async",
  }),
  batchIngestRuns: channel<
    [runs: LangSmithBatchIngestRuns, options?: unknown],
    Awaited<ReturnType<NonNullable<LangSmithClient["batchIngestRuns"]>>>
  >({
    channelName: "Client.batchIngestRuns",
    kind: "async",
  }),
});
