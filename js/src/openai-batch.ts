import { openAIChannels } from "./instrumentation/plugins/openai-channels";
import type {
  CompleteOpenAIBatchTraceArgs,
  OpenAIBatchLike,
  StartOpenAIBatchTraceArgs,
} from "./openai-batch-types";

/**
 * Start a trace for a new OpenAI Batch, with pending spans for its requests.
 *
 * Supported endpoints are `/v1/chat/completions` and `/v1/responses`.
 */
export async function startOpenAIBatchTrace<TBatch extends OpenAIBatchLike>(
  args: StartOpenAIBatchTraceArgs<TBatch>,
): Promise<TBatch> {
  const batch = await openAIChannels.batchesStartTrace.invoke(
    async (input) =>
      await input.client.batches.create({
        ...input.params,
        input_file_id: input.inputFile.id,
      }),
    undefined,
    [args],
    {},
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return batch as TBatch;
}

/**
 * Complete an OpenAI Batch trace from caller-supplied Batch API data.
 *
 * This helper performs no OpenAI API requests. Pass the Responses or promises
 * returned by `client.files.content()` for the input and result files, JSONL
 * strings, or iterables of parsed records.
 */
export async function completeOpenAIBatchTrace<TBatch extends OpenAIBatchLike>(
  args: CompleteOpenAIBatchTraceArgs<TBatch>,
): Promise<TBatch> {
  const input = Promise.resolve(args.input);
  const outputFile =
    args.outputFile === undefined
      ? undefined
      : Promise.resolve(args.outputFile);
  const errorFile =
    args.errorFile === undefined ? undefined : Promise.resolve(args.errorFile);

  // Content requests are commonly started before this helper is called. Attach
  // rejection handlers immediately so early no-op paths and disabled
  // instrumentation cannot leave caller-supplied promises unhandled.
  void input.catch(() => undefined);
  void outputFile?.catch(() => undefined);
  void errorFile?.catch(() => undefined);

  const batch = await openAIChannels.batchesCompleteTrace.invoke(
    async (input) => input.batch,
    undefined,
    [{ ...args, input, outputFile, errorFile }],
    {},
  );
  // The completion channel preserves the exact batch object supplied by the
  // caller, including fields from a newer OpenAI SDK version.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return batch as TBatch;
}
