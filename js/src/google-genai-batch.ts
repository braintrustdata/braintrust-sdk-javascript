import type {
  CompleteGeminiDeveloperBatchTraceArgs,
  CompleteGeminiDeveloperBatchTraceResult,
  GeminiDeveloperBatchFile,
  GeminiDeveloperBatchJSONL,
  GeminiDeveloperBatchLike,
  GeminiDeveloperBatchTraceContext,
  StartGeminiDeveloperBatchTraceArgs,
} from "./google-genai-batch-types";
import {
  completeGoogleGenAIBatchTrace,
  startGoogleGenAIBatchTrace,
} from "./instrumentation/plugins/google-genai-batch-instrumentation";

function protectBatchFilePromise(
  file: GeminiDeveloperBatchFile | undefined,
): Promise<GeminiDeveloperBatchJSONL> | undefined {
  if (file === undefined) {
    return undefined;
  }
  const promise = Promise.resolve(file);
  // Attach immediately so an early tracing exit cannot leave a caller-owned
  // rejection unhandled.
  void promise.catch(() => undefined);
  return promise;
}

/**
 * Start pending Braintrust spans for a Gemini Developer API batch that the
 * caller has already created with `ai.batches.create()`.
 *
 * This helper performs no Google API requests. Persist the returned opaque
 * context alongside the provider batch name for later completion.
 */
export async function startGeminiDeveloperBatchTrace<
  TBatch extends GeminiDeveloperBatchLike,
>(
  args: StartGeminiDeveloperBatchTraceArgs<TBatch>,
): Promise<GeminiDeveloperBatchTraceContext | undefined> {
  const input = protectBatchFilePromise(args.input);
  return await startGoogleGenAIBatchTrace({ ...args, input });
}

/**
 * Complete Gemini Developer API batch spans from caller-supplied Batch API
 * data.
 *
 * This helper performs no Google API requests. Inline results are read from
 * `batch.dest.inlinedResponses`; file-backed results must be supplied through
 * `outputFile`. If `traceContext` is omitted or cannot be resumed, the helper
 * creates a collect-only trace under the active Braintrust parent. Persist the
 * returned `traceContext` and pass it to later retries so they update the same
 * spans even when they run under a different active parent.
 */
export async function completeGeminiDeveloperBatchTrace<
  TBatch extends GeminiDeveloperBatchLike,
>(
  args: CompleteGeminiDeveloperBatchTraceArgs<TBatch>,
): Promise<CompleteGeminiDeveloperBatchTraceResult<TBatch>> {
  const input = protectBatchFilePromise(args.input);
  const outputFile = protectBatchFilePromise(args.outputFile);

  const traceContext = await completeGoogleGenAIBatchTrace({
    ...args,
    input,
    outputFile,
  });
  return {
    batch: args.batch,
    ...(traceContext ? { traceContext } : {}),
  };
}
