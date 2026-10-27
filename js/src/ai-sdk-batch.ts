import { registerInstrumentation } from "./instrumentation/registrations/aisdk";
import { aiSDKBatchChannels } from "./instrumentation/providers/ai-sdk-batch-interceptors";
import type {
  CompleteAISDKBatchTraceArgs,
  StartAISDKBatchTraceArgs,
} from "./vendor-sdk-types/ai-sdk-batch";

/**
 * Capture inputs after the caller has successfully submitted an AI SDK text batch.
 * This does not submit the batch or call any provider API.
 *
 * Persist the returned opaque context alongside the batch reference and original
 * requests. Pass them to `completeAISDKBatchTrace` after collecting the results,
 * including in another process. Flush the logger before handing off the work.
 * The context contains routing and an input-identity digest, not prompts or keys.
 * Treat it as trusted application state. Returns undefined if capture is disabled
 * or the supplied data is unsupported.
 */
export function startAISDKBatchTrace(
  args: StartAISDKBatchTraceArgs,
): Promise<string | undefined> {
  registerInstrumentation();
  return aiSDKBatchChannels.start.invoke(
    async () => undefined,
    undefined,
    [args],
    {},
  );
}

/**
 * Capture already collected AI SDK batch results and finish the original spans.
 * This does not poll, fetch results, or consume provider streams. The caller must
 * collect the stream into records first, including results of failed batches.
 * Pending batches and completed batches with missing results remain pending.
 * Retrying with the same context and results updates the same rows.
 *
 * Without context, captures inputs and results together under the current parent.
 * Original request IDs/models must match the context when one is supplied.
 * Verify webhook signatures in application code; a webhook is not trace context.
 */
export function completeAISDKBatchTrace(
  args: CompleteAISDKBatchTraceArgs,
): Promise<void> {
  registerInstrumentation();
  return aiSDKBatchChannels.complete.invoke(
    async () => undefined,
    undefined,
    [args],
    {},
  );
}
