import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  GroqChatCompletion,
  GroqChatCompletionChunk,
  GroqChatCreateParams,
  GroqChatStream,
  GroqEmbeddingCreateParams,
  GroqEmbeddingResponse,
} from "../../vendor-sdk-types/groq";
import type {
  BindGroqBatchTraceArgs,
  CollectGroqBatchTraceArgs,
  CompleteGroqBatchTraceArgs,
  FailGroqBatchTraceArgs,
  GroqBatchesCreateTraceArgs,
  GroqBatchesRetrieveTraceArgs,
  GroqBatchCreateParams,
  GroqBatchLike,
  GroqBatchTraceContext,
  GroqFileLike,
  GroqFilesCreateTraceArgs,
  StartGroqBatchTraceArgs,
} from "../../groq-batch-types";

type GroqChatResult = GroqChatCompletion | GroqChatStream;

export const groqChannels = defineChannels(
  "groq-sdk",
  {
    filesCreateTraced: channel<[GroqFilesCreateTraceArgs], GroqFileLike>({
      channelName: "files.create-traced",
      kind: "async",
    }),

    batchesCreateTraced: channel<[GroqBatchesCreateTraceArgs], GroqBatchLike>({
      channelName: "batches.create-traced",
      kind: "async",
    }),

    batchesRetrieveTraced: channel<
      [GroqBatchesRetrieveTraceArgs],
      GroqBatchLike
    >({
      channelName: "batches.retrieve-traced",
      kind: "async",
    }),

    batchesCompleteTrace: channel<
      [CompleteGroqBatchTraceArgs<GroqBatchLike>],
      void
    >({
      channelName: "batches.complete-trace",
      kind: "async",
    }),

    batchesStartTrace: channel<
      [StartGroqBatchTraceArgs],
      GroqBatchCreateParams
    >({
      channelName: "batches.start-trace",
      kind: "async",
    }),

    batchesBindTrace: channel<
      [BindGroqBatchTraceArgs<GroqBatchLike>],
      { traceContext?: GroqBatchTraceContext }
    >({
      channelName: "batches.bind-trace",
      kind: "async",
    }),

    batchesCollectTrace: channel<
      [CollectGroqBatchTraceArgs<GroqBatchLike>],
      GroqBatchLike
    >({
      channelName: "batches.collect-trace",
      kind: "async",
    }),

    batchesFailTrace: channel<[FailGroqBatchTraceArgs], void>({
      channelName: "batches.fail-trace",
      kind: "async",
    }),

    chatCompletionsCreate: channel<
      [GroqChatCreateParams],
      GroqChatResult,
      Record<string, unknown>,
      GroqChatCompletionChunk
    >({
      channelName: "chat.completions.create",
      kind: "async",
    }),

    embeddingsCreate: channel<
      [GroqEmbeddingCreateParams],
      GroqEmbeddingResponse
    >({
      channelName: "embeddings.create",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.GROQ },
);
