import { isInvocationContext } from "../../global-instrumentation-hooks";
import { isPromiseLike, SpanTypeAttribute } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import { startSpan } from "../../logger";
import {
  withSpanInstrumentationName,
  type SpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { isAsyncIterable, patchStreamIfNeeded } from "../core/stream-patcher";
import type { ChannelConfig } from "../core/channel-tracing-utils";

/**
 * Intercepts a channel while still tracing direct tracePromise()/traceSync()
 * callers. Generated auto-instrumentation and manual wrappers mark the legacy
 * contexts around intercepted calls, which the interceptor already traces.
 */
export function traceLegacyCallers<TChannel, TConfig extends ChannelConfig>(
  channel: TChannel,
  config: TConfig,
  trace: (channel: TChannel, config: TConfig) => () => void,
  intercept: (channel: TChannel, config: TConfig) => () => void,
): () => void {
  const unsubscribers = [
    intercept(channel, config),
    trace(channel, {
      ...config,
      shouldTrace: (args, event) =>
        !isInvocationContext(event) &&
        (config.shouldTrace?.(args, event) ?? true),
    }),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

type ToolChannel = {
  instrumentationName: SpanInstrumentationName;
  intercept(
    interceptor: (
      target: (this: unknown, ...args: unknown[]) => unknown,
      thisArg: unknown,
      args: unknown[],
      additional: { toolCallId?: string; toolName: string },
    ) => unknown,
  ): () => void;
};

/**
 * Traces tool executions. Tools run in the caller's span context, failures are
 * logged as Errors, promise results are chained, and async iterable results
 * are observed until their final chunk.
 */
export function interceptToolExecute(channel: ToolChannel): () => void {
  return channel.intercept((target, thisArg, args, additional) => {
    if (isAutoInstrumentationSuppressed()) {
      return Reflect.apply(target, thisArg, args);
    }

    const { toolCallId, toolName } = additional;
    const span = startSpan(
      withSpanInstrumentationName(
        {
          name: toolName,
          spanAttributes: { type: SpanTypeAttribute.TOOL },
          event: {
            input: args[0],
            metadata: {
              provider: "openrouter",
              tool_name: toolName,
              ...(toolCallId ? { tool_call_id: toolCallId } : {}),
            },
          },
        },
        channel.instrumentationName,
      ),
    );
    const startTime = getCurrentUnixTimestamp();
    const logErrorAndEnd = (error: unknown) => {
      span.log({ error });
      span.end();
    };
    const logToolFailureAndEnd = (error: unknown) =>
      logErrorAndEnd(error instanceof Error ? error : new Error(String(error)));
    // Like the previous event subscribers, observation failures never change
    // the tool's outcome.
    const finish = (result: unknown) => {
      try {
        if (!isAsyncIterable(result)) {
          span.log({ output: result, metrics: {} });
          span.end();
          return;
        }

        let firstChunkTime: number | undefined;
        patchStreamIfNeeded(result, {
          onChunk: () => {
            firstChunkTime ??= getCurrentUnixTimestamp();
          },
          onComplete: (chunks) => {
            span.log({
              output: chunks.at(-1),
              metrics:
                firstChunkTime === undefined
                  ? {}
                  : { time_to_first_token: firstChunkTime - startTime },
            });
            span.end();
          },
          onCancel: () => {
            const error = new Error("Stream cancelled before completion");
            error.name = "AbortError";
            logErrorAndEnd(error);
          },
          onError: logErrorAndEnd,
        });
      } catch (error) {
        debugLogger.error("Error observing OpenRouter tool result:", error);
      }
    };

    let result: unknown;
    try {
      result = Reflect.apply(target, thisArg, args);
    } catch (error) {
      logToolFailureAndEnd(error);
      throw error;
    }

    if (isPromiseLike(result)) {
      return result.then(
        (resolved) => {
          finish(resolved);
          return resolved;
        },
        (error) => {
          logToolFailureAndEnd(error);
          throw error;
        },
      );
    }

    finish(result);
    return result;
  });
}
