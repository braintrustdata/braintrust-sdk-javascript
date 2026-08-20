import {
  completeMistralBatchTraceImpl,
  failMistralBatchTraceImpl,
  startMistralBatchTraceImpl,
} from "./instrumentation/plugins/mistral-batch-instrumentation";
import { getSpanParentObject } from "./logger";
import type {
  CompleteMistralBatchTraceArgs,
  FailMistralBatchTraceArgs,
  MistralBatchCreateParams,
  MistralBatchLike,
  MistralBatchTraceCollection,
  StartMistralBatchTraceArgs,
} from "./mistral-batch-types";

/**
 * Start a trace for a new Mistral Batch, with pending spans for its requests,
 * and return the parameters to pass to `mistral.batch.jobs.create()`.
 */
export async function startMistralBatchTrace(
  args: StartMistralBatchTraceArgs,
): Promise<MistralBatchCreateParams> {
  return await startMistralBatchTraceImpl(args);
}

/**
 * Complete a Mistral Batch trace from caller-supplied Batch API data.
 *
 * This helper performs no Mistral API requests. Supplied Response and stream
 * bodies are consumed directly. Inline `batch.outputs` are used when
 * `outputContent` is omitted. Provider file IDs must be downloaded before
 * their contents are supplied as `outputContent` or `errorContent`. For a
 * collect-only trace, persist the returned `collectionContext` and pass it to
 * every retry so that all attempts update the same spans.
 */
export async function completeMistralBatchTrace<
  TBatch extends MistralBatchLike,
>(
  args: CompleteMistralBatchTraceArgs<TBatch>,
): Promise<MistralBatchTraceCollection<TBatch>> {
  const outputContent =
    args.outputContent === undefined
      ? undefined
      : Promise.resolve(args.outputContent);
  const errorContent =
    args.errorContent === undefined
      ? undefined
      : Promise.resolve(args.errorContent);

  void outputContent?.catch(() => undefined);
  void errorContent?.catch(() => undefined);

  return await completeMistralBatchTraceImpl(
    { ...args, outputContent, errorContent },
    getSpanParentObject(),
  );
}

/** End pending Mistral Batch spans after `batch.jobs.create()` fails. */
export async function failMistralBatchTrace(
  args: FailMistralBatchTraceArgs,
): Promise<void> {
  await failMistralBatchTraceImpl(args);
}
