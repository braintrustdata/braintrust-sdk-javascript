import { isObject } from "../../../util/index";
import { uint8ArrayToBase64 } from "../../../util/bytes";
import { prepareTypedAttachments } from "../../typed-attachments";
import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent } from "../../logger/core";
import type { Span } from "../../logger/core";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type {
  TypeSafeAPIPromise,
  TypeSafeImage,
  TypeSafeTextWithAssets,
  TypeSafeSystemOneRequest,
  TypeSafeSystemOneResult,
} from "../../vendor-sdk-types/typesafe";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { isAutoCaptureAttachmentsEnabled } from "../../wrappers/attachment-utils";

import { typeSafeChannels } from "./typesafe-interceptors";

export function registerTypeSafeInstrumentation(): void {
  typeSafeChannels.systemOne.intercept((target, thisArg, args) =>
    interceptSystemOne(target, thisArg, args),
  );
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
            metadata: {
              ...(model ? { model } : {}),
              provider: "typesafe",
            },
          },
          name: "typesafe.systemOne",
          spanAttributes: { type: "decision" },
        },
        INSTRUMENTATION_NAMES.TYPESAFE,
      ),
    );
  } catch (error) {
    debugLogger.error("Error starting span for typesafe.systemOne:", error);
    return invokeTarget();
  }

  // Snapshot caller-owned bytes before invoking the provider. Blob reads may
  // finish asynchronously, but never delay the provider call or replace its promise.
  const prepared = prepareTypeSafeInput(args[0]).catch(() => {
    debugLogger.error("Error capturing input for typesafe.systemOne");
    return { input: undefined, imagePath: undefined };
  });
  let result: PromiseLike<TypeSafeSystemOneResult>;
  try {
    result = withCurrent(span, () =>
      runWithAutoInstrumentationSuppressed(invokeTarget),
    );
  } catch (error) {
    void prepared.then(({ input }) => {
      span.log({ input, error });
      span.end();
    });
    throw error;
  }

  if (!isTypeSafeAPIPromise(result)) {
    const finished = Promise.resolve(result).then(
      async (value) => finishSuccessfulSpan(span, value, await prepared),
      async (error) => {
        span.log({ input: (await prepared).input, error });
        span.end();
      },
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
        finishSuccessfulSpan(span, value, await prepared);
      } catch (error) {
        debugLogger.error(
          "Error reading response for typesafe.systemOne:",
          error,
        );
        span.log({ input: (await prepared).input });
        span.end();
      }
    },
    async (error) => {
      span.log({ input: (await prepared).input, error });
      span.end();
    },
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
  { input, imagePath }: Awaited<ReturnType<typeof prepareTypeSafeInput>>,
): void {
  const metrics = extractMetrics(result);
  span.log({
    input,
    output:
      isObject(result) && result.answers !== undefined
        ? { answers: addIds(result.answers, imagePath) }
        : undefined,
    ...(isObject(result) && typeof result.model === "string"
      ? { metadata: { model: result.model } }
      : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  });
  span.end();
}

function addIds(value: unknown, imagePath?: string): unknown {
  if (!isObject(value)) {
    return value;
  }

  return Object.entries(value).map(([id, entry]) =>
    isObject(entry)
      ? {
          ...entry,
          id,
          ...(entry.type === "box" && imagePath && !("image_path" in entry)
            ? { image_path: imagePath }
            : {}),
        }
      : { id, value: entry },
  );
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

/** Normalize SDK media in place; shared decision processing uploads after customization. */
async function prepareTypeSafeInput(request: TypeSafeSystemOneRequest) {
  const capture = isAutoCaptureAttachmentsEnabled();
  const namedAssets = new Map(Object.entries(request.assets ?? {}));
  const captured = new Map<TypeSafeImage, Promise<unknown>>();
  const imagePaths: string[] = [];

  const expand = (
    text: string,
    references: Map<string, TypeSafeImage>,
    path: string,
    depth: number,
  ): Promise<unknown> => {
    const names = [...references.keys()]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (!names.length) return Promise.resolve(text);
    const pattern = new RegExp(
      `(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
      "g",
    );
    const parts = text.split(pattern).filter((part) => part !== "");
    if (!parts.some((part) => references.has(part)))
      return Promise.resolve(text);
    // A standalone reference stays at its original location. Templates become
    // ordered text/media parts instead of moving images into an asset side table.
    if (parts.length === 1)
      return visit(references.get(parts[0]), path, depth + 1);
    return Promise.all(
      parts.map((part, index) =>
        references.has(part)
          ? visit(references.get(part), `${path}/${index}`, depth + 1)
          : part,
      ),
    );
  };
  const visit = async (
    value: unknown,
    path: string,
    depth = 0,
  ): Promise<unknown> => {
    if (depth >= 128) return "<omitted>";
    if (typeof value === "string")
      return expand(value, namedAssets, path, depth);
    if (Array.isArray(value))
      return Promise.all(
        value.map((item, index) => visit(item, `${path}/${index}`, depth + 1)),
      );
    if (value === null || typeof value !== "object") return value;
    if (Symbol.for("@typesafe-ai/sdk/image") in value) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- The shared SDK brand identifies images across package copies.
      const asset = value as unknown as TypeSafeImage;
      imagePaths.push(path);
      if (!capture) return { type: "image" };
      if (!captured.has(asset)) {
        captured.set(
          asset,
          (async () => {
            try {
              const data = asset.data;
              const bytes =
                data instanceof Blob
                  ? new Uint8Array(await data.arrayBuffer())
                  : new Uint8Array(data);
              // TypeSafe detects PNG/JPEG from bytes, including Blobs without MIME.
              const contentType = [137, 80, 78, 71, 13, 10, 26, 10].every(
                (byte, i) => bytes[i] === byte,
              )
                ? "image/png"
                : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
                  ? "image/jpeg"
                  : undefined;
              const base64 = uint8ArrayToBase64(bytes);
              return contentType
                ? `data:${contentType};base64,${base64}`
                : { type: "image", data: base64 };
            } catch {
              // Preserve the SDK's serialized reference when the bytes cannot be
              // read. A capture failure must not discard the decision or its boxes.
              return asset.toString();
            }
          })(),
        );
      }
      return captured.get(asset);
    }
    if (Symbol.for("@typesafe-ai/sdk/text-with-assets") in value) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- The SDK brand identifies text templates across package copies.
      const template = value as unknown as TypeSafeTextWithAssets;
      return expand(
        template.text,
        new Map([
          ...namedAssets,
          ...template.assets.map((asset): [string, TypeSafeImage] => [
            asset.toString(),
            asset,
          ]),
        ]),
        path,
        depth,
      );
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return value;
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, child]) => [
          key,
          await visit(
            child,
            `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
            depth + 1,
          ),
        ]),
      ),
    );
  };
  const [state, questions] = await Promise.all([
    visit(request.state, "/state"),
    Promise.all(
      Object.entries(request.questions).map(async ([id, question], index) => {
        if (!isObject(question)) return { id, value: question };
        const [instructions, criteria] = await Promise.all([
          visit(question.instructions, `/questions/${index}/instructions`),
          visit(question.criteria, `/questions/${index}/criteria`),
        ]);
        return {
          ...question,
          id,
          ...("instructions" in question ? { instructions } : {}),
          ...("criteria" in question ? { criteria } : {}),
        };
      }),
    ),
  ]);
  return {
    input: prepareTypedAttachments({ state, questions }),
    // Jev exposes no structured image selector. Repeated occurrences have
    // distinct paths; neither answer order nor instruction text selects one.
    imagePath: imagePaths.length === 1 ? imagePaths[0] : undefined,
  };
}
