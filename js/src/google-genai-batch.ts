import type {
  CompleteGoogleGenAIBatchTraceArgs,
  GeminiDeveloperBatchCreateParams,
  GeminiDeveloperBatchFile,
  GeminiDeveloperBatchGetParams,
  GeminiDeveloperBatchJSONL,
  GeminiDeveloperBatchLike,
  GoogleGenAIBatchesCreateResource,
  GoogleGenAIBatchesCreateTraceOptions,
  GoogleGenAIBatchesGetResource,
} from "./google-genai-batch-types";
import { googleGenAIChannels } from "./instrumentation/plugins/google-genai-channels";
import { ensureGoogleGenAIBatchInstrumentation } from "./instrumentation/plugins/google-genai-batch-instrumentation";
import { getSpanParentObject } from "./logger";

function protectBatchFilePromise(
  file: GeminiDeveloperBatchFile | undefined,
): Promise<GeminiDeveloperBatchJSONL> | undefined {
  if (file === undefined) {
    return undefined;
  }
  const promise = Promise.resolve(file);
  void promise.catch(() => undefined);
  return promise;
}

/**
 * Wrap `ai.batches.create` to create a pending Braintrust batch trace after
 * Google accepts the batch.
 *
 * Pass the `ai.batches` resource, then call the returned function with the same
 * creation parameters. For a file-backed batch, pass the original JSONL as
 * `inputFileContent`; inline requests are read directly from `params.src`.
 *
 * @example
 * ```ts
 * const batch = await googleGenAIBatchesCreateTraced(ai.batches)(params);
 * ```
 */
export function googleGenAIBatchesCreateTraced<
  TParams extends GeminiDeveloperBatchCreateParams,
  TBatch extends GeminiDeveloperBatchLike,
>(
  batches: GoogleGenAIBatchesCreateResource<TParams, TBatch>,
): (
  params: TParams,
  traceOptions?: GoogleGenAIBatchesCreateTraceOptions,
) => Promise<TBatch> {
  ensureGoogleGenAIBatchInstrumentation();
  return (params, traceOptions) => {
    const inputFileContent = protectBatchFilePromise(
      traceOptions?.inputFileContent,
    );
    return googleGenAIChannels.batchesCreateTraced.invoke(
      () => batches.create(params),
      batches,
      [{ params, inputFileContent, parent: getSpanParentObject() }],
      {},
    ) as Promise<TBatch>;
  };
}

/**
 * Wrap `ai.batches.get` to update a previously started Google GenAI batch
 * trace. Terminal inline batches are completed directly from
 * `batch.dest.inlinedResponses`. File-backed batches remain pending until
 * their downloaded output is passed to `completeGoogleGenAIBatchTrace`.
 *
 * @example
 * ```ts
 * const batch = await googleGenAIBatchesGetTraced(ai.batches)({name});
 * ```
 */
export function googleGenAIBatchesGetTraced<
  TParams extends GeminiDeveloperBatchGetParams,
  TBatch extends GeminiDeveloperBatchLike,
>(
  batches: GoogleGenAIBatchesGetResource<TParams, TBatch>,
): (params: TParams) => Promise<TBatch> {
  ensureGoogleGenAIBatchInstrumentation();
  return (params) =>
    googleGenAIChannels.batchesGetTraced.invoke(
      () => batches.get(params),
      batches,
      [{ params }],
      {},
    ) as Promise<TBatch>;
}

/**
 * Add caller-supplied results to a Google GenAI batch trace.
 *
 * This helper performs no Google API requests. When creation was traced in the
 * same process, only the terminal batch and downloaded output are needed. For
 * collect-only tracing in another process, also pass either `inlinedRequests`
 * or the original `inputFileContent`.
 */
export async function completeGoogleGenAIBatchTrace<
  TBatch extends GeminiDeveloperBatchLike,
>(args: CompleteGoogleGenAIBatchTraceArgs<TBatch>): Promise<void> {
  ensureGoogleGenAIBatchInstrumentation();
  const inputFileContent = protectBatchFilePromise(args.inputFileContent);
  const outputFileContent = protectBatchFilePromise(args.outputFileContent);
  await googleGenAIChannels.batchesCompleteTrace.invoke(
    async () => undefined,
    undefined,
    [{ ...args, inputFileContent, outputFileContent }],
    {},
  );
}
