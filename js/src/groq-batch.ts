import { groqChannels } from "./instrumentation/plugins/groq-channels";
import type {
  BindGroqBatchTraceArgs,
  CollectGroqBatchTraceArgs,
  FailGroqBatchTraceArgs,
  GroqBatchCreateParams,
  GroqBatchLike,
  GroqBatchTraceContext,
  StartGroqBatchTraceArgs,
} from "./groq-batch-types";

/**
 * Start a trace for a new Groq Batch, with pending spans for its requests, and
 * return the parameters to pass to `groq.batches.create()`.
 *
 * Only `/v1/chat/completions` batches are supported.
 * Iterable inputs must be supplied through a factory that returns a fresh
 * iterable on every call so submission failures can resume the pending spans.
 * Instrumentation enforces Groq's 50,000-record and 100 MB batch limits.
 * Inputs are validated in one pass and replayed for bounded streaming span
 * emission, supporting the full provider file limit.
 */
export async function startGroqBatchTrace(
  args: StartGroqBatchTraceArgs,
): Promise<GroqBatchCreateParams> {
  return await groqChannels.batchesStartTrace.invoke(
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
 * Bind an accepted Groq Batch ID to the pending trace created by
 * `startGroqBatchTrace()`.
 *
 * Call this with the object returned by `groq.batches.create()`, then retain
 * the opaque result for `collectGroqBatchTrace()`. This helper performs no Groq
 * API requests and returns `undefined` when the batch has no valid pending
 * Braintrust context.
 */
export async function bindGroqBatchTrace<TBatch extends GroqBatchLike>(
  args: BindGroqBatchTraceArgs<TBatch>,
): Promise<GroqBatchTraceContext | undefined> {
  const result = await groqChannels.batchesBindTrace.invoke(
    async (): Promise<{ traceContext?: GroqBatchTraceContext }> => ({}),
    undefined,
    [args],
    {},
  );
  return result.traceContext;
}

/**
 * Collect a Groq Batch trace from caller-supplied Batch API data.
 *
 * This helper performs no Groq API requests. Supplied Response bodies are
 * consumed directly. Completed batches are validated and staged atomically in
 * a bounded 16 MiB result buffer before span updates are emitted. Result-file
 * factories are validated in one pass and replayed for bounded streaming
 * emission, supporting the full 100 MB provider limit. Without signed start
 * context, collect-only tracing also uses a bounded 16 MiB normalized-input
 * buffer and otherwise skips with a debug diagnostic. Files are limited to
 * Groq's 50,000-record and 100 MB limits. A trace started with
 * `startGroqBatchTrace()` also requires the opaque context returned by
 * `bindGroqBatchTrace()`. Local collection failures leave completed-batch
 * spans pending so callers can retry with fresh or replayable file sources.
 */
export async function collectGroqBatchTrace<TBatch extends GroqBatchLike>(
  args: CollectGroqBatchTraceArgs<TBatch>,
): Promise<TBatch> {
  const inputFile = Promise.resolve(args.inputFile);
  const outputFile =
    args.outputFile === undefined
      ? undefined
      : Promise.resolve(args.outputFile);
  const errorFile =
    args.errorFile === undefined ? undefined : Promise.resolve(args.errorFile);

  void inputFile.catch(() => undefined);
  void outputFile?.catch(() => undefined);
  void errorFile?.catch(() => undefined);

  const batch = await groqChannels.batchesCollectTrace.invoke(
    async (input) => input.batch,
    undefined,
    [{ ...args, inputFile, outputFile, errorFile }],
    {},
  );
  // The channel preserves the exact caller-supplied batch object, including
  // fields from newer Groq SDK versions.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return batch as TBatch;
}

/**
 * End a pending Groq Batch trace after `groq.batches.create()` rejects.
 *
 * The original replayable input is required to validate and resume every child
 * span. This helper performs no Groq API requests and never rethrows the
 * supplied error.
 */
export async function failGroqBatchTrace(
  args: FailGroqBatchTraceArgs,
): Promise<void> {
  await groqChannels.batchesFailTrace.invoke(
    async () => undefined,
    undefined,
    [args],
    {},
  );
}
