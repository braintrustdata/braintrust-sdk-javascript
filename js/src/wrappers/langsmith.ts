import type { Score } from "../../util";
import { Eval, type EvalResultWithSummary } from "../framework";
import { debugLogger } from "../debug-logger";
import iso from "../isomorph";
import { isObject, isPlainObject } from "../util";
import type {
  LangSmithClient,
  LangSmithEvalData,
  LangSmithEvaluate,
  LangSmithEvaluateOptions,
  LangSmithEvaluateSource,
  LangSmithEvaluationResult,
  LangSmithEvaluationResults,
  LangSmithEvaluator,
  LangSmithExample,
  LangSmithRecord,
  LangSmithRun,
} from "../vendor-sdk-types/langsmith";

export type BraintrustLangSmithEvalResult = EvalResultWithSummary<
  LangSmithRecord,
  unknown,
  LangSmithExample,
  LangSmithRecord
>;

export interface WrapLangSmithEvaluateOptions {
  /**
   * Skip the original LangSmith evaluation and run only Braintrust. Defaults to
   * `BRAINTRUST_STANDALONE=1` when the option is omitted.
   */
  standalone?: boolean;
  /** Braintrust project name for the migrated evaluation. */
  projectName?: string;
  /** Braintrust project ID for the migrated evaluation. */
  projectId?: string;
  /**
   * LangSmith client used to load dataset-name strings. A client supplied to
   * `evaluate()` takes precedence over this client.
   */
  client?: LangSmithClient;
  /** Called after the Braintrust evaluation succeeds in either mode. */
  onBraintrustResult?: (
    result: BraintrustLangSmithEvalResult,
  ) => void | Promise<void>;
  /** Called after the Braintrust evaluation fails in either mode. */
  onBraintrustError?: (error: unknown) => void | Promise<void>;
}

type BraintrustLangSmithEvaluate = (
  target: Parameters<LangSmithEvaluate>[0],
  options: LangSmithEvaluateOptions,
) => Promise<BraintrustLangSmithEvalResult>;

type EnvironmentConfiguredLangSmithEvaluate<TResult> = (
  target: Parameters<LangSmithEvaluate>[0],
  options: LangSmithEvaluateOptions,
) => Promise<TResult | BraintrustLangSmithEvalResult>;

const BRAINTRUST_LANGSMITH_EVALUATE_WRAPPER = Symbol(
  "braintrust.langsmith.evaluate.wrapper",
);

type MarkedLangSmithEvaluate = LangSmithEvaluateSource & {
  [BRAINTRUST_LANGSMITH_EVALUATE_WRAPPER]?: true;
};

/**
 * Wrap LangSmith's standard `evaluate()` function so the same evaluation is
 * also recorded as a Braintrust experiment.
 *
 * In tandem mode, both evaluations run concurrently and the returned promise
 * preserves LangSmith's result and error behavior. In standalone mode, only
 * Braintrust runs and the returned promise resolves to Braintrust's
 * `EvalResultWithSummary`.
 *
 * @example
 * ```typescript
 * import { evaluate as langSmithEvaluate } from "langsmith/evaluation";
 * import { wrapLangSmithEvaluate } from "braintrust";
 *
 * const evaluate = wrapLangSmithEvaluate(langSmithEvaluate, {
 *   projectName: "my-project",
 *   standalone: true,
 * });
 *
 * await evaluate(async ({ text }) => ({ length: String(text).length }), {
 *   data: [{ inputs: { text: "hello" }, outputs: { length: 5 } }],
 *   evaluators: [({ outputs, referenceOutputs }) => ({
 *     key: "correct",
 *     score: outputs.length === referenceOutputs?.length,
 *   })],
 * });
 * ```
 */
export function wrapLangSmithEvaluate<TResult>(
  evaluate: LangSmithEvaluateSource<TResult>,
  options: WrapLangSmithEvaluateOptions & { standalone: true },
): BraintrustLangSmithEvaluate;
export function wrapLangSmithEvaluate<TResult>(
  evaluate: LangSmithEvaluateSource<TResult>,
  options: WrapLangSmithEvaluateOptions & { standalone: false },
): LangSmithEvaluate<TResult>;
export function wrapLangSmithEvaluate<TResult>(
  evaluate: LangSmithEvaluateSource<TResult>,
  options?: WrapLangSmithEvaluateOptions,
): EnvironmentConfiguredLangSmithEvaluate<TResult>;
export function wrapLangSmithEvaluate<TResult>(
  evaluate: LangSmithEvaluateSource<TResult>,
  options: WrapLangSmithEvaluateOptions = {},
): EnvironmentConfiguredLangSmithEvaluate<TResult> {
  if (typeof evaluate !== "function") {
    throw new TypeError("Expected LangSmith evaluate to be a function");
  }

  if (
    (evaluate as MarkedLangSmithEvaluate)[BRAINTRUST_LANGSMITH_EVALUATE_WRAPPER]
  ) {
    return evaluate as EnvironmentConfiguredLangSmithEvaluate<TResult>;
  }

  const standalone =
    options.standalone ?? iso.getEnv("BRAINTRUST_STANDALONE") === "1";
  const projectName =
    options.projectName ??
    iso.getEnv("LANGSMITH_PROJECT") ??
    iso.getEnv("LANGCHAIN_PROJECT") ??
    iso.getEnv("BRAINTRUST_PROJECT") ??
    "langsmith-migration";
  const originalEvaluate = evaluate as unknown as LangSmithEvaluate<TResult>;

  const notifyBraintrustError = async (error: unknown) => {
    debugLogger.warn("LangSmith Braintrust evaluation failed", error);
    try {
      await options.onBraintrustError?.(error);
    } catch (callbackError) {
      debugLogger.warn(
        "LangSmith Braintrust error callback failed",
        callbackError,
      );
    }
  };

  const notifyBraintrustResult = async (
    result: BraintrustLangSmithEvalResult,
  ) => {
    try {
      await options.onBraintrustResult?.(result);
    } catch (error) {
      debugLogger.warn("LangSmith Braintrust result callback failed", error);
      try {
        await options.onBraintrustError?.(error);
      } catch (callbackError) {
        debugLogger.warn(
          "LangSmith Braintrust error callback failed",
          callbackError,
        );
      }
    }
  };

  const wrapped = async (
    target: Parameters<LangSmithEvaluate>[0],
    callOptions: LangSmithEvaluateOptions,
  ): Promise<TResult | BraintrustLangSmithEvalResult> => {
    if (Array.isArray(target)) {
      throw new Error(
        "LangSmith comparative evaluations are not supported by wrapLangSmithEvaluate",
      );
    }
    if (
      callOptions.summaryEvaluators !== undefined &&
      callOptions.summaryEvaluators.length > 0
    ) {
      throw new Error(
        "LangSmith summary evaluators are not supported by wrapLangSmithEvaluate",
      );
    }
    if (!callOptions.evaluators || callOptions.evaluators.length === 0) {
      throw new Error(
        "wrapLangSmithEvaluate requires at least one row evaluator",
      );
    }
    const evaluators = callOptions.evaluators;
    if (
      callOptions.targetConcurrency !== undefined &&
      callOptions.evaluationConcurrency !== undefined &&
      callOptions.targetConcurrency !== callOptions.evaluationConcurrency
    ) {
      throw new Error(
        "Braintrust Eval uses one concurrency limit; set maxConcurrency or matching targetConcurrency and evaluationConcurrency values",
      );
    }
    if (
      typeof target !== "function" &&
      (!isObject(target) || typeof Reflect.get(target, "invoke") !== "function")
    ) {
      throw new TypeError(
        "LangSmith evaluation target must be a function or expose invoke()",
      );
    }

    const client = callOptions.client ?? options.client;
    if (typeof callOptions.data === "string" && !client) {
      throw new Error(
        "A LangSmith client is required to migrate a dataset-name string. Pass client to evaluate() or wrapLangSmithEvaluate().",
      );
    }

    let langSmithData = callOptions.data;
    if (!standalone && isAsyncIterable(callOptions.data)) {
      const bufferedData: LangSmithExample[] = [];
      for await (const example of callOptions.data) {
        bufferedData.push(example);
      }
      langSmithData = bufferedData;
    }

    const runBraintrustEvaluation = async () => {
      const data = convertLangSmithData(
        langSmithData,
        client,
        callOptions.includeAttachments,
      );
      const targetName =
        typeof target === "function" && target.name ? target.name : "target";
      const maxConcurrency =
        callOptions.maxConcurrency ??
        callOptions.targetConcurrency ??
        callOptions.evaluationConcurrency;

      return await Eval<
        LangSmithRecord,
        unknown,
        LangSmithExample,
        LangSmithRecord
      >(projectName, {
        data,
        task: async (input, hooks) => {
          const config = callOptions.includeAttachments
            ? { attachments: hooks.expected.attachments }
            : undefined;
          if (typeof target === "function") {
            return config === undefined
              ? await target(input)
              : await target(input, config);
          }
          const invoke = Reflect.get(target, "invoke") as (
            input: LangSmithRecord,
            config?: { attachments?: LangSmithExample["attachments"] },
          ) => unknown | Promise<unknown>;
          return config === undefined
            ? await invoke.call(target, input)
            : await invoke.call(target, input, config);
        },
        scores: evaluators.map((evaluator, index) => {
          const scorer = async ({
            input,
            output,
            expected,
            trace,
          }: {
            input: LangSmithRecord;
            output: unknown;
            expected: LangSmithExample;
            trace?: {
              getConfiguration(): {
                object_id: string;
                root_span_id: string;
              };
            };
          }): Promise<Score[]> => {
            const outputs = isPlainObject(output)
              ? { ...output }
              : { outputs: output };
            const traceConfig = trace?.getConfiguration();
            const runId =
              traceConfig?.root_span_id ?? expected.id ?? "braintrust-eval";
            const run: LangSmithRun = {
              id: runId,
              name: targetName,
              run_type: "chain",
              inputs: input,
              outputs,
              trace_id: runId,
              ...(traceConfig?.object_id
                ? { session_id: traceConfig.object_id }
                : {}),
              ...(expected.id ? { reference_example_id: expected.id } : {}),
            };

            let rawResults:
              | LangSmithEvaluationResult
              | LangSmithEvaluationResult[]
              | LangSmithEvaluationResults;
            if (
              isObject(evaluator) &&
              typeof Reflect.get(evaluator, "evaluateRun") === "function"
            ) {
              const evaluateRun = Reflect.get(evaluator, "evaluateRun") as (
                run: LangSmithRun,
                example?: LangSmithExample,
              ) =>
                | LangSmithEvaluationResult
                | LangSmithEvaluationResults
                | Promise<
                    LangSmithEvaluationResult | LangSmithEvaluationResults
                  >;
              rawResults = await evaluateRun.call(evaluator, run, expected);
            } else if (typeof evaluator === "function") {
              rawResults = await evaluator(
                {
                  ...run,
                  run,
                  example: expected,
                  inputs: expected.inputs,
                  outputs,
                  referenceOutputs: expected.outputs,
                  attachments: expected.attachments,
                },
                expected,
              );
            } else {
              throw new TypeError("Invalid LangSmith evaluator");
            }

            const nestedResults = isObject(rawResults)
              ? Reflect.get(rawResults, "results")
              : undefined;
            const results = Array.isArray(rawResults)
              ? rawResults
              : Array.isArray(nestedResults)
                ? nestedResults
                : [rawResults];

            return results.map((result, resultIndex) => {
              if (!isObject(result)) {
                throw new TypeError(
                  "LangSmith evaluators must return evaluation result objects",
                );
              }
              const key = Reflect.get(result, "key");
              if (key !== undefined && typeof key !== "string") {
                throw new TypeError(
                  "LangSmith evaluation result keys must be strings",
                );
              }
              const rawScore = Reflect.get(result, "score");
              if (
                rawScore !== undefined &&
                rawScore !== null &&
                typeof rawScore !== "number" &&
                typeof rawScore !== "boolean"
              ) {
                throw new TypeError(
                  "LangSmith evaluation result scores must be numbers, booleans, or null",
                );
              }

              const metadata: Record<string, unknown> = {};
              for (const field of [
                "value",
                "comment",
                "correction",
                "evaluatorInfo",
                "sourceRunId",
                "targetRunId",
                "feedbackConfig",
                "metadata",
              ]) {
                const value = Reflect.get(result, field);
                if (value !== undefined) {
                  metadata[field] = value;
                }
              }

              return {
                name:
                  key ??
                  evaluatorName(evaluator, index) ??
                  `score_${resultIndex}`,
                score:
                  typeof rawScore === "boolean"
                    ? rawScore
                      ? 1
                      : 0
                    : (rawScore ?? null),
                ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
              };
            });
          };
          Object.defineProperty(scorer, "name", {
            configurable: true,
            value: evaluatorName(evaluator, index),
          });
          return scorer;
        }),
        experimentName: callOptions.experimentPrefix,
        description: callOptions.description,
        metadata: callOptions.metadata,
        trialCount: callOptions.numRepetitions,
        maxConcurrency,
        projectId: options.projectId,
      });
    };

    if (standalone) {
      try {
        const result = await runBraintrustEvaluation();
        await notifyBraintrustResult(result);
        return result;
      } catch (error) {
        await notifyBraintrustError(error);
        throw error;
      }
    }

    const langSmithOptions =
      langSmithData === callOptions.data
        ? callOptions
        : { ...callOptions, data: langSmithData };
    const langSmithPromise = Promise.resolve().then(() =>
      originalEvaluate(target, langSmithOptions),
    );
    const braintrustPromise = runBraintrustEvaluation();
    const [langSmithResult, braintrustResult] = await Promise.allSettled([
      langSmithPromise,
      braintrustPromise,
    ]);

    if (braintrustResult.status === "fulfilled") {
      await notifyBraintrustResult(braintrustResult.value);
    } else {
      await notifyBraintrustError(braintrustResult.reason);
    }

    if (langSmithResult.status === "rejected") {
      throw langSmithResult.reason;
    }
    return langSmithResult.value;
  };

  Object.defineProperty(wrapped, BRAINTRUST_LANGSMITH_EVALUATE_WRAPPER, {
    value: true,
  });
  return wrapped;
}

function convertLangSmithData(
  data: LangSmithEvalData,
  client: LangSmithClient | undefined,
  includeAttachments: boolean | undefined,
) {
  const examples =
    typeof data === "string"
      ? client!.listExamples({
          datasetName: data,
          includeAttachments,
        })
      : data;

  return (async function* () {
    for await (const example of examples) {
      if (!isObject(example) || !isPlainObject(example.inputs)) {
        throw new TypeError(
          "LangSmith evaluation data must contain examples with object inputs",
        );
      }
      yield {
        input: example.inputs,
        expected: example,
        metadata: isPlainObject(example.metadata) ? example.metadata : {},
      };
    }
  })();
}

function isAsyncIterable(
  value: LangSmithEvalData,
): value is AsyncIterable<LangSmithExample> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    return typeof Reflect.get(value, Symbol.asyncIterator) === "function";
  } catch {
    return false;
  }
}

function evaluatorName(evaluator: LangSmithEvaluator, index: number) {
  if (typeof evaluator === "function" && evaluator.name) {
    return evaluator.name;
  }
  if (isObject(evaluator)) {
    const evaluateRun = Reflect.get(evaluator, "evaluateRun");
    if (typeof evaluateRun === "function" && evaluateRun.name) {
      return evaluateRun.name;
    }
  }
  return `evaluator_${index}`;
}
