import { openAIChannels } from "./instrumentation/plugins/openai-channels";
import type {
  CompleteOpenAIBatchTraceArgs,
  OpenAIBatchCreateParams,
  OpenAIBatchLike,
  StartOpenAIBatchTraceArgs,
} from "./openai-batch-types";

/**
 * Start a trace for a new OpenAI Batch, with pending spans for its requests,
 * and return the parameters to pass to `client.batches.create()`.
 *
 * Supported endpoints are `/v1/chat/completions` and `/v1/responses`.
 */
export async function startOpenAIBatchTrace(
  args: StartOpenAIBatchTraceArgs,
): Promise<OpenAIBatchCreateParams> {
  return await openAIChannels.batchesStartTrace.invoke(
    async (input) => ({
      ...input.params,
      input_file_id: input.inputFile.id,
    }),
    undefined,
    [args],
    {},
  );
}

/**
 * Complete an OpenAI Batch trace from caller-supplied Batch API data.
 *
 * This helper performs no OpenAI API requests. Pass the Responses or promises
 * returned by `client.files.content()` for the input and result files, JSONL
 * strings, or iterables of parsed records. Supplied Response bodies are
 * consumed directly.
 */
export async function completeOpenAIBatchTrace<TBatch extends OpenAIBatchLike>(
  args: CompleteOpenAIBatchTraceArgs<TBatch>,
): Promise<TBatch> {
  const inputFile = Promise.resolve(args.inputFile);
  const outputFile =
    args.outputFile === undefined
      ? undefined
      : Promise.resolve(args.outputFile);
  const errorFile =
    args.errorFile === undefined ? undefined : Promise.resolve(args.errorFile);

  // Content requests are commonly started before this helper is called. Attach
  // rejection handlers immediately so early no-op paths and disabled
  // instrumentation cannot leave caller-supplied promises unhandled.
  void inputFile.catch(() => undefined);
  void outputFile?.catch(() => undefined);
  void errorFile?.catch(() => undefined);

  const batch = await openAIChannels.batchesCompleteTrace.invoke(
    async (input) => input.batch,
    undefined,
    [{ ...args, inputFile, outputFile, errorFile }],
    {},
  );
  // The completion channel preserves the exact batch object supplied by the
  // caller, including fields from a newer OpenAI SDK version.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return batch as TBatch;
}
