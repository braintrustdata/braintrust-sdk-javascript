import { SpanTypeAttribute, isObject } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent } from "../../logger";
import type { Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type {
  TypeSafeAPIPromise,
  TypeSafeSystemOneRequest,
  TypeSafeSystemOneResult,
} from "../../vendor-sdk-types/typesafe";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { typeSafeChannels } from "./typesafe-channels";

export class TypeSafePlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      typeSafeChannels.systemOne.intercept((target, thisArg, args) =>
        interceptSystemOne(target, thisArg, args),
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

function interceptSystemOne(
  target: (
    this: unknown,
    request: TypeSafeSystemOneRequest,
    options?: unknown,
  ) => PromiseLike<TypeSafeSystemOneResult>,
  thisArg: unknown,
  args: [TypeSafeSystemOneRequest, options?: unknown],
): PromiseLike<TypeSafeSystemOneResult> {
  const invokeTarget = () => Reflect.apply(target, thisArg, args);
  if (isAutoInstrumentationSuppressed()) {
    return invokeTarget();
  }

  let span: Span;
  try {
    const request = args[0];
    const model =
      typeof request?.model === "string"
        ? request.model
        : isObject(thisArg) && typeof thisArg.defaultModel === "string"
          ? thisArg.defaultModel
          : undefined;
    span = startSpan(
      withSpanInstrumentationName(
        {
          event: {
            input: {
              state: request?.state,
              questions: request?.questions,
            },
            metadata: {
              ...(model ? { model } : {}),
              provider: "typesafe",
            },
          },
          name: "typesafe.systemOne",
          spanAttributes: { type: SpanTypeAttribute.LLM },
        },
        INSTRUMENTATION_NAMES.TYPESAFE,
      ),
    );
  } catch (error) {
    debugLogger.error("Error starting span for typesafe.systemOne:", error);
    return invokeTarget();
  }

  let result: PromiseLike<TypeSafeSystemOneResult>;
  try {
    result = withCurrent(span, () =>
      runWithAutoInstrumentationSuppressed(invokeTarget),
    );
  } catch (error) {
    finishTypeSafeSpan(span, () => span.log({ error }));
    throw error;
  }

  if (!isTypeSafeAPIPromise(result)) {
    const finished = Promise.resolve(result).then(
      (value) => finishSuccessfulSpan(span, value),
      (error) => finishTypeSafeSpan(span, () => span.log({ error })),
    );
    void finished;
    return result;
  }

  const originalAsResponse = result.asResponse.bind(result);
  const captureFinished = originalAsResponse().then(
    async (response) => {
      try {
        const value = await response.clone().json();
        if (!isObject(value)) {
          throw new TypeError("Expected TypeSafe to return a JSON object");
        }
        finishSuccessfulSpan(span, value);
      } catch (error) {
        debugLogger.error(
          "Error reading response for typesafe.systemOne:",
          error,
        );
        finishTypeSafeSpan(span, () => {});
      }
    },
    (error) => finishTypeSafeSpan(span, () => span.log({ error })),
  );
  preserveTypeSafePromise(result, captureFinished);
  return result;
}

function isTypeSafeAPIPromise(
  value: PromiseLike<TypeSafeSystemOneResult>,
): value is TypeSafeAPIPromise<TypeSafeSystemOneResult> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "asResponse") === "function" &&
    typeof Reflect.get(value, "withResponse") === "function" &&
    typeof Reflect.get(value, "map") === "function"
  );
}

function preserveTypeSafePromise<T>(
  apiPromise: TypeSafeAPIPromise<T>,
  captureFinished: Promise<void>,
): void {
  try {
    const originalThen = apiPromise.then.bind(apiPromise);
    const originalAsResponse = apiPromise.asResponse.bind(apiPromise);
    const originalWithResponse = apiPromise.withResponse.bind(apiPromise);
    const originalMap = apiPromise.map.bind(apiPromise);

    const waitForCapture = async <V>(value: V): Promise<V> => {
      await captureFinished;
      return value;
    };
    const then = <TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> =>
      originalThen(
        async (value) => {
          await captureFinished;
          if (onfulfilled) {
            return onfulfilled(value);
          }
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Promise.then returns the original value when no callback is supplied.
          return value as unknown as TResult1;
        },
        async (error) => {
          await captureFinished;
          if (onrejected) {
            return onrejected(error);
          }
          throw error;
        },
      );

    Object.defineProperties(apiPromise, {
      asResponse: {
        configurable: true,
        value: () => originalAsResponse().then(waitForCapture),
      },
      catch: {
        configurable: true,
        value: <TResult = never>(
          onrejected?:
            | ((reason: unknown) => TResult | PromiseLike<TResult>)
            | null,
        ) => then(undefined, onrejected),
      },
      finally: {
        configurable: true,
        value: (onfinally?: (() => void) | null) =>
          then(
            async (value) => {
              await onfinally?.();
              return value;
            },
            async (error) => {
              await onfinally?.();
              throw error;
            },
          ),
      },
      map: {
        configurable: true,
        value: <U>(fn: (data: T) => U) => {
          const mapped = originalMap(fn);
          preserveTypeSafePromise(mapped, captureFinished);
          return mapped;
        },
      },
      then: { configurable: true, value: then },
      withResponse: {
        configurable: true,
        value: () => originalWithResponse().then(waitForCapture),
      },
    });
  } catch (error) {
    debugLogger.error("Error preserving TypeSafe APIPromise helpers:", error);
  }
}

function finishSuccessfulSpan(
  span: Span,
  result: TypeSafeSystemOneResult,
): void {
  finishTypeSafeSpan(span, () => {
    const metrics = extractMetrics(result);
    span.log({
      output: isObject(result) ? result.answers : undefined,
      ...(isObject(result) && typeof result.model === "string"
        ? { metadata: { model: result.model } }
        : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    });
  });
}

function extractMetrics(
  result: TypeSafeSystemOneResult,
): Record<string, number> {
  const usage = isObject(result) && isObject(result.usage) ? result.usage : {};
  const promptTokens = validTokenCount(usage.input_tokens);
  const completionTokens = validTokenCount(usage.output_tokens);
  return {
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(completionTokens !== undefined
      ? { completion_tokens: completionTokens }
      : {}),
    ...(promptTokens !== undefined && completionTokens !== undefined
      ? { tokens: promptTokens + completionTokens }
      : {}),
  };
}

function validTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function finishTypeSafeSpan(span: Span, log: () => void): void {
  try {
    log();
  } catch (error) {
    debugLogger.error("Error logging span for typesafe.systemOne:", error);
  }
  try {
    span.end();
  } catch (error) {
    debugLogger.error("Error ending span for typesafe.systemOne:", error);
  }
}
