import { isObject, SpanTypeAttribute } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent, type Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/tracing";
import { lumaAIChannels } from "./lumaai-interceptors";

export class LumaAIPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      lumaAIChannels.generationsCreate.intercept((target, receiver, args) =>
        traceGeneration(
          () => Reflect.apply(target, receiver, args),
          args[0],
          "create",
        ),
      ),
      lumaAIChannels.generationsGet.intercept((target, receiver, args) =>
        traceGeneration(
          () => Reflect.apply(target, receiver, args),
          args[0],
          "get",
        ),
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function pick(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function traceGeneration(
  call: () => PromiseLike<unknown>,
  request: unknown,
  operation: "create" | "get",
): PromiseLike<unknown> {
  if (isAutoInstrumentationSuppressed()) return call();

  let span: Span;
  try {
    span = startSpan(
      withSpanInstrumentationName(
        {
          name: `lumaai.generations.${operation}`,
          spanAttributes: {
            type:
              operation === "create"
                ? SpanTypeAttribute.LLM
                : SpanTypeAttribute.TOOL,
          },
          event: {
            input:
              operation === "create"
                ? pick(request, ["prompt", "keyframes", "concepts"])
                : { id: request },
            metadata: {
              provider: "lumaai",
              ...(operation === "create"
                ? pick(request, [
                    "model",
                    "aspect_ratio",
                    "duration",
                    "resolution",
                    "loop",
                  ])
                : {}),
            },
          },
        },
        INSTRUMENTATION_NAMES.LUMAAI,
      ),
    );
  } catch (error) {
    debugLogger.error("Error starting Luma AI span:", error);
    return call();
  }

  let result: PromiseLike<unknown>;
  try {
    result = withCurrent(span, () =>
      runWithAutoInstrumentationSuppressed(call),
    );
  } catch (error) {
    finishSpan(span, () => span.log({ error }));
    throw error;
  }

  // Luma 1.x parses its response lazily. Observing APIPromise.then() directly
  // consumes the body even when the caller only uses asResponse(). Capture a
  // clone before making the raw response available to any of the SDK helpers.
  // The APIPromise, response, parsed result and provider errors retain identity.
  if (isObject(result) && result.responsePromise instanceof Promise) {
    const observed = result.responsePromise.then(
      async (props: unknown) => {
        try {
          const response = isObject(props) ? props.response : undefined;
          if (!isObject(response) || typeof response.clone !== "function") {
            throw new TypeError("Expected a Luma AI response");
          }
          finishGenerationSpan(span, await response.clone().json());
        } catch (error) {
          debugLogger.error("Error reading Luma AI response:", error);
          finishSpan(span, () => {});
        }
        return props;
      },
      (error) => {
        finishSpan(span, () => span.log({ error }));
        throw error;
      },
    );
    result.responsePromise = observed;
    void observed.catch(() => {});
    return result;
  }

  void Promise.resolve(result).then(
    (value) => finishGenerationSpan(span, value),
    (error) => finishSpan(span, () => span.log({ error })),
  );
  return result;
}

function finishGenerationSpan(span: Span, value: unknown): void {
  finishSpan(span, () => {
    span.log({
      output: pick(value, [
        "id",
        "state",
        "assets",
        "failure_reason",
        "generation_type",
        "created_at",
      ]),
      metadata: pick(value, ["model"]),
      ...(isObject(value) && value.state === "failed"
        ? {
            error:
              typeof value.failure_reason === "string"
                ? value.failure_reason
                : "Luma AI generation failed",
          }
        : {}),
    });
  });
}

function finishSpan(span: Span, log: () => void): void {
  try {
    log();
  } catch (error) {
    debugLogger.error("Error logging Luma AI span:", error);
  }
  try {
    span.end();
  } catch (error) {
    debugLogger.error("Error ending Luma AI span:", error);
  }
}
