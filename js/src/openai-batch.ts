import { openAIChannels } from "./instrumentation/plugins/openai-channels";
import type {
  CompleteOpenAIBatchArgs,
  CreateOpenAIBatchArgs,
  OpenAIBatchLike,
} from "./openai-batch-types";

/**
 * Create an OpenAI Batch and start pending Braintrust spans for its requests.
 *
 * Supported endpoints are `/v1/chat/completions` and `/v1/responses`.
 */
export async function createOpenAIBatch<TBatch extends OpenAIBatchLike>(
  args: CreateOpenAIBatchArgs<TBatch>,
): Promise<TBatch> {
  const batch = await openAIChannels.batchesCreate.invoke(
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
 * Complete pending OpenAI Batch spans from caller-supplied Batch API data.
 *
 * This helper performs no OpenAI API requests. Pass the Responses or promises
 * returned by `client.files.content()` for the input and result files, JSONL
 * strings, or iterables of parsed records.
 */
export async function completeOpenAIBatch<TBatch extends OpenAIBatchLike>(
  args: CompleteOpenAIBatchArgs<TBatch>,
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

  const batch = await openAIChannels.batchesComplete.invoke(
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
