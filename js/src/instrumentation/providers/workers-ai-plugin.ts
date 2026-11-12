import { isObject } from "../../../util/index";
import { prepareTypedAttachments } from "../../typed-attachments";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  WorkersAIInput,
  WorkersAIResult,
} from "../../vendor-sdk-types/workers-ai";

import { traceAsyncCall } from "../core/tracing";
import { workersAIChannels } from "./workers-ai-interceptors";

const DECISION_MODELS = new Set([
  "@cf/cloudflare/clef",
  "@cf/cloudflare/clef-flash",
  "@cf/cloudflare/clef-omni",
]);

const EXTRACTION_FIELD_PROPERTIES = [
  "type",
  "instructions",
  "unit",
  "integer",
  "decimals",
  "items",
  "min",
  "max",
  "step",
  "scale",
  "null_threshold",
  "horizon",
  "interval",
] as const;
const SCALAR_RESULT_PROPERTIES = ["guess", "p_null", "confidence"] as const;
const ESTIMATE_RESULT_PROPERTIES = [
  "mean",
  "median",
  "p10",
  "p90",
  "p_below",
  "p_above",
  "quantiles",
] as const;
const EXTRACTION_RESULT_PROPERTIES = new Map<string, readonly string[]>([
  ["text", [...SCALAR_RESULT_PROPERTIES, "span"]],
  ["number", SCALAR_RESULT_PROPERTIES],
  ["date", SCALAR_RESULT_PROPERTIES],
  ["time", SCALAR_RESULT_PROPERTIES],
  ["datetime", SCALAR_RESULT_PROPERTIES],
  ["duration", [...SCALAR_RESULT_PROPERTIES, "unit"]],
  ["list", ["spans", "confidence"]],
  ["estimate", ESTIMATE_RESULT_PROPERTIES],
  ["forecast", ESTIMATE_RESULT_PROPERTIES],
]);

function pickExtractionProperties(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key) && value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

function extractWorkersAIExtraction(result: WorkersAIResult): unknown {
  return {
    answers: Object.entries(result.answers ?? {}).map(([id, answer]) => ({
      id,
      ...pickExtractionProperties(answer, [
        "type",
        "value",
        ...(typeof answer?.type === "string"
          ? (EXTRACTION_RESULT_PROPERTIES.get(answer.type) ?? [])
          : []),
      ]),
      ...(answer?.type === "forecast" && answer.steps !== undefined
        ? {
            steps: Array.isArray(answer.steps)
              ? answer.steps.map((step) =>
                  isObject(step)
                    ? pickExtractionProperties(step, [
                        "value",
                        ...ESTIMATE_RESULT_PROPERTIES,
                      ])
                    : step,
                )
              : answer.steps,
          }
        : {}),
    })),
    ...pickExtractionProperties(result, ["truncated", "state_text"]),
  };
}

export function registerWorkersAIInstrumentation(): void {
  workersAIChannels.run.intercept((target, receiver, args, additional) => {
    const extraction = args[0] === "@cf/cloudflare/clairic";
    return traceAsyncCall<typeof workersAIChannels.run>(
      () => Reflect.apply(target, receiver, args),
      { ...additional, arguments: args, self: receiver },
      {
        name: "workers_ai.run",
        type: extraction ? "extraction" : "decision",
        instrumentationName: INSTRUMENTATION_NAMES.WORKERS_AI,
        // These models return JSON directly. Do not consume raw bodies or
        // claim to trace an asynchronous submission or unsupported stream.
        shouldTrace: () =>
          (extraction || DECISION_MODELS.has(args[0])) &&
          !args[1]?.stream &&
          !args[2]?.returnRawResponse &&
          !args[2]?.websocket &&
          !args[2]?.queueRequest,
        extractInput: ([model, input]) => ({
          input: prepareWorkersAIInput(input, extraction),
          metadata: {
            model,
            provider: "cloudflare",
            operation: extraction ? "extraction" : "decision",
          },
        }),
        extractOutput: (result) =>
          extraction
            ? extractWorkersAIExtraction(result)
            : {
                answers: Object.entries(result.answers ?? {}).map(
                  ([id, answer]) => ({ ...answer, id }),
                ),
              },
        extractMetadata: (result) => ({
          ...(typeof result.model === "string" ? { model: result.model } : {}),
        }),
        extractMetrics: extractWorkersAIUsage,
      },
    );
  });
}

function prepareWorkersAIInput(
  input: WorkersAIInput,
  extraction: boolean,
): unknown {
  const media = Object.fromEntries(
    (["images", "audio", "videos"] as const)
      .filter((key) => input[key] !== undefined)
      .map((key) => [
        key,
        input[key]?.map((item) => {
          const mediaType =
            typeof item === "string"
              ? item.match(/^data:([^;,]+);base64,/i)?.[1]
              : item.content_type;
          return {
            type: "file",
            ...(mediaType ? { mediaType } : {}),
            data: typeof item === "string" ? item : item.base64,
          };
        }),
      ]),
  );
  if (extraction) {
    return prepareTypedAttachments({
      state: input.state === undefined ? null : input.state,
      fields: Object.entries(input.fields ?? {}).map(([id, field]) => ({
        id,
        ...pickExtractionProperties(field, EXTRACTION_FIELD_PROPERTIES),
      })),
      ...(input.images !== undefined ? { images: media.images } : {}),
      ...(input.reference_date !== undefined
        ? { reference_date: input.reference_date }
        : {}),
      ...(input.options !== undefined
        ? {
            options: pickExtractionProperties(input.options, [
              "include_quantiles",
              "return_state_text",
            ]),
          }
        : {}),
    });
  }
  // The decision contract keeps all supplied context in state. Keep the
  // provider's separate media arrays alongside its original state there.
  return prepareTypedAttachments({
    state: Object.keys(media).length
      ? { state: input.state, ...media }
      : input.state,
    questions: Object.entries(input.questions ?? {}).map(([id, question]) => ({
      id,
      type: question.type,
      instructions: question.instructions,
      ...(question.criteria !== undefined
        ? { criteria: question.criteria }
        : {}),
    })),
  });
}

function extractWorkersAIUsage(
  result: WorkersAIResult,
): Record<string, number> {
  const usage = isObject(result.usage) ? result.usage : {};
  const metrics: Record<string, number> = {};
  for (const [source, target] of [
    ["input_tokens", "prompt_tokens"],
    ["output_tokens", "completion_tokens"],
    ["total_tokens", "tokens"],
  ] as const) {
    const value = usage[source];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0)
      metrics[target] = value;
  }
  if (
    metrics.tokens === undefined &&
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  ) {
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  }
  return metrics;
}
