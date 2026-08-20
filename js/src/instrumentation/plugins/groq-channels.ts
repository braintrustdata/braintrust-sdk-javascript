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
  FailGroqBatchTraceArgs,
  GroqBatchCreateParams,
  GroqBatchLike,
  GroqBatchTraceContext,
  StartGroqBatchTraceArgs,
} from "../../groq-batch-types";

type GroqChatResult = GroqChatCompletion | GroqChatStream;

export const groqChannels = defineChannels(
  "groq-sdk",
  {
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
