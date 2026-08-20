import type {
  CompleteGeminiDeveloperBatchTraceArgs,
  CompleteGeminiDeveloperBatchTraceResult,
  GeminiDeveloperBatchLike,
  GeminiDeveloperBatchTraceContext,
  StartGeminiDeveloperBatchTraceArgs,
} from "./google-genai-batch-types";
import {
  completeGoogleGenAIBatchTrace,
  startGoogleGenAIBatchTrace,
} from "./instrumentation/plugins/google-genai-batch-instrumentation";

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
  const input =
    args.input === undefined ? undefined : Promise.resolve(args.input);
  // Attach immediately so disabled instrumentation and other early no-op paths
  // cannot leave a caller-supplied rejected promise unhandled.
  void input?.catch(() => undefined);
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
  const input =
    args.input === undefined ? undefined : Promise.resolve(args.input);
  const outputFile =
    args.outputFile === undefined
      ? undefined
      : Promise.resolve(args.outputFile);

  // File requests are commonly started before this helper is called. Attach
  // rejection handlers immediately so early no-op paths and disabled
  // instrumentation cannot leave caller-supplied promises unhandled.
  void input?.catch(() => undefined);
  void outputFile?.catch(() => undefined);

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
