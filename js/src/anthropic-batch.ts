import { anthropicChannels } from "./instrumentation/plugins/anthropic-channels";
import type {
  AnthropicBatchCreateParams,
  AnthropicBatchLike,
  AnthropicBatchTraceContext,
  BindAnthropicBatchTraceArgs,
  CompleteAnthropicBatchTraceArgs,
  FailAnthropicBatchTraceArgs,
  StartAnthropicBatchTraceArgs,
  StartAnthropicBatchTraceResult,
} from "./anthropic-batch-types";

/**
 * Start a resumable trace for an Anthropic Message Batch without calling
 * Anthropic. After creating the provider batch, bind this context with
 * {@link bindAnthropicBatchTrace} and persist the bound value.
 */
export async function startAnthropicBatchTrace<
  TParams extends AnthropicBatchCreateParams,
>(
  args: StartAnthropicBatchTraceArgs<TParams>,
): Promise<StartAnthropicBatchTraceResult<TParams>> {
  const result = await anthropicChannels.batchesStartTrace.invoke(
    async (input) => ({ params: { ...input.params } }),
    undefined,
    [args],
    {},
  );
  // The channel uses the minimum structural batch type while this public API
  // preserves caller fields from newer Anthropic SDK versions.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return result as StartAnthropicBatchTraceResult<TParams>;
}

/** Bind a started trace context to the batch returned by Anthropic. */
export async function bindAnthropicBatchTrace<
  TBatch extends AnthropicBatchLike,
>(
  args: BindAnthropicBatchTraceArgs<TBatch>,
): Promise<AnthropicBatchTraceContext | undefined> {
  const result = await anthropicChannels.batchesBindTrace.invoke(
    async (input) => ({ traceContext: input.traceContext }),
    undefined,
    [args],
    {},
  );
  return result.traceContext;
}

/**
 * Complete an Anthropic Message Batch trace from caller-supplied batch data and
 * the iterable returned by `client.messages.batches.results()`. Either the
 * batch-bound value returned by {@link bindAnthropicBatchTrace} resumes the
 * started spans. An unbound or omitted context creates a collect-only trace.
 */
export async function completeAnthropicBatchTrace<
  TBatch extends AnthropicBatchLike,
  TParams extends AnthropicBatchCreateParams,
>(args: CompleteAnthropicBatchTraceArgs<TBatch, TParams>): Promise<TBatch> {
  const batch = await anthropicChannels.batchesCompleteTrace.invoke(
    async (input) => input.batch,
    undefined,
    [args],
    {},
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return batch as TBatch;
}

/** End pending Anthropic batch spans after the caller's submission fails. */
export async function failAnthropicBatchTrace<
  TParams extends AnthropicBatchCreateParams,
>(args: FailAnthropicBatchTraceArgs<TParams>): Promise<void> {
  await anthropicChannels.batchesFailTrace.invoke(
    async () => undefined,
    undefined,
    [args],
    {},
  );
}
