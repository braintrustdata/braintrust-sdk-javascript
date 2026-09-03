import { anthropicChannels } from "./instrumentation/plugins/anthropic-channels";
import { getSpanParentObject } from "./logger";
import type {
  AnthropicAPIPromise,
  AnthropicBatchCreateParams,
  AnthropicBatchLike,
  AnthropicBatchesCreateTracedOptions,
  AnthropicBatchesResource,
  AnthropicEnhancedResponse,
  CompleteAnthropicBatchTraceArgs,
} from "./anthropic-batch-types";
import { createLazyAPIPromise } from "./wrappers/openai-promise-utils";

/**
 * Wrap `client.messages.batches.create` to trace an Anthropic Message Batch.
 *
 * Pass `client.messages.batches`, then call the returned function with the same
 * arguments as `client.messages.batches.create`. The returned value preserves
 * Anthropic's `APIPromise` helpers.
 *
 * @example
 * ```ts
 * const batch = await anthropicBatchesCreateTraced(
 *   client.messages.batches,
 * )({ requests });
 * ```
 */
export function anthropicBatchesCreateTraced<
  TParams extends AnthropicBatchCreateParams,
  TBatch extends AnthropicBatchLike,
  TOptions = unknown,
>(
  batches: AnthropicBatchesResource<TParams, TBatch, TOptions>,
  traceOptions: AnthropicBatchesCreateTracedOptions = {},
): (params: TParams, requestOptions?: TOptions) => AnthropicAPIPromise<TBatch> {
  return (params, requestOptions) => {
    const parent = getSpanParentObject({ state: traceOptions.state });
    const apiPromise = batches.create(params, requestOptions);
    let enhancedResponse: AnthropicEnhancedResponse<TBatch> | undefined;
    const tracedResponse = anthropicChannels.batchesCreateTraced
      .invoke(
        async () => {
          enhancedResponse = await apiPromise.withResponse();
          return enhancedResponse.data;
        },
        batches,
        [{ params, parent, state: traceOptions.state }],
        {},
      )
      .then((data) => {
        if (!enhancedResponse) {
          throw new Error(
            "Expected Anthropic withResponse() to provide a response",
          );
        }
        return { ...enhancedResponse, data };
      });

    return createLazyAPIPromise(
      () => tracedResponse,
      () => tracedResponse.then(({ response }) => response),
      () => apiPromise,
    );
  };
}

/**
 * Add result data to spans created by `anthropicBatchesCreateTraced`.
 *
 * This helper performs no Anthropic API requests. Pass the terminal batch, the
 * original create parameters, and the iterable returned by
 * `client.messages.batches.results(batch.id)`. If creation was not traced in
 * this process, the helper creates a collect-only trace.
 */
export async function completeAnthropicBatchTrace<
  TBatch extends AnthropicBatchLike,
  TParams extends AnthropicBatchCreateParams,
>(args: CompleteAnthropicBatchTraceArgs<TBatch, TParams>): Promise<void> {
  const results = Promise.resolve(args.results);
  void results.catch(() => undefined);

  await anthropicChannels.batchesCompleteTrace.invoke(
    async () => undefined,
    undefined,
    [{ ...args, results }],
    {},
  );
}
