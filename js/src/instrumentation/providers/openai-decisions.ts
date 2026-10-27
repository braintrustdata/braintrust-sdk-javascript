import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent, type Span } from "../../logger/core";
import { parseMetricsFromUsage } from "../../openai-utils";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type { OpenAIDecision } from "../../vendor-sdk-types/openai-decisions";
import type { OpenAIAPIPromise } from "../../vendor-sdk-types/openai-common";
import {
  isAutoCaptureAttachmentsEnabled,
  processInputAttachments,
} from "../../wrappers/attachment-utils";
import {
  isAutoInstrumentationSuppressed,
  runWithAutoInstrumentationSuppressed,
} from "../auto-instrumentation-suppression";
import { buildStartSpanArgs } from "../core/tracing-utils";
import type { openAIChannels } from "./openai-interceptors";
import type {
  ArgsOf,
  InvocationAdditionalOf,
} from "../core/interceptor-definitions";

// Object keys cannot distinguish boolean true from string "true". Quote string
// choices when both occur, keeping criteria, selected choices and probabilities aligned.
function choiceKeys(
  values: (string | boolean)[],
): Map<string | boolean, string> {
  const collides = values.some(
    (value) => typeof value === "boolean" && values.includes(String(value)),
  );
  return new Map(
    values.map((value) => [
      value,
      collides ? JSON.stringify(value) : String(value),
    ]),
  );
}

export function traceOpenAIDecisions(
  call: () => PromiseLike<OpenAIDecision>,
  context: {
    arguments: ArgsOf<typeof openAIChannels.decisionsCreate>;
    self: unknown;
    additional: InvocationAdditionalOf<typeof openAIChannels.decisionsCreate>;
  },
): PromiseLike<OpenAIDecision> {
  const args = context.arguments;
  const additional = context.additional;
  if (isAutoInstrumentationSuppressed()) return call();
  let span: Span;
  try {
    const params = args[0];
    const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
      { name: "openai.decisions.create", type: "question" },
      { ...additional, arguments: args },
    );
    span = startSpan(
      withSpanInstrumentationName(
        {
          name,
          spanAttributes,
          event: {
            input: {
              state: processInputAttachments(
                // OpenAI accepts images in user-message content only;
                // instructions and rubric values are textual provider fields.
                params.input,
                isAutoCaptureAttachmentsEnabled(),
              ),
              questions: params.questions.map((question, index) => {
                const base = {
                  id: question.name ?? String(index),
                  instructions: question.instructions,
                };
                if (question.type === "predicate")
                  return { ...base, type: "boolean" };
                if (question.type === "choice") {
                  const keys = choiceKeys(
                    question.choices.map((choice) => choice.value),
                  );
                  return {
                    ...base,
                    type: "choice",
                    criteria: Object.fromEntries(
                      question.choices.map((choice) => [
                        keys.get(choice.value),
                        choice.description ?? null,
                      ]),
                    ),
                  };
                }
                return {
                  ...base,
                  type: "score",
                  criteria: question.levels.map((level) =>
                    level.description
                      ? `${level.label}: ${level.description}`
                      : level.label,
                  ),
                };
              }),
            },
            metadata: {
              model: params.model,
              provider: "openai",
              ...spanInfoMetadata,
            },
          },
        },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    );
  } catch (error) {
    debugLogger.error("Error starting OpenAI decision span:", error);
    return call();
  }

  let finished = false;
  const finish = (value?: OpenAIDecision, error?: unknown) => {
    if (finished) return;
    finished = true;
    if (error !== undefined) span.log({ error });
    if (value) {
      try {
        const answers = value.answers.map((answer, index) => {
          const { name, ...rest } = answer;
          const id = name ?? args[0].questions[index]?.name ?? String(index);
          if (rest.type === "predicate")
            return { id, type: "boolean", probability: rest.probability };
          if (rest.type === "choice") {
            const keys = choiceKeys(
              rest.probabilities.map((entry) => entry.value),
            );
            return {
              id,
              ...rest,
              choice: keys.get(rest.choice),
              probabilities: Object.fromEntries(
                rest.probabilities.map((entry) => [
                  keys.get(entry.value),
                  entry.probability,
                ]),
              ),
            };
          }
          if (rest.type === "score")
            return {
              id,
              ...rest,
              probabilities: Object.fromEntries(
                rest.probabilities.map((entry) => [
                  entry.value,
                  entry.probability,
                ]),
              ),
              legend: Object.fromEntries(
                rest.probabilities.map((entry) => [entry.value, entry.label]),
              ),
            };
          return { id, ...rest };
        });
        span.log({
          output: { answers },
          metadata: { model: value.model },
          metrics: parseMetricsFromUsage(value.usage),
        });
      } catch (error) {
        debugLogger.error("Error extracting OpenAI decision result:", error);
      }
    }
    span.end();
  };

  try {
    const result = withCurrent(span, () =>
      runWithAutoInstrumentationSuppressed(() => call()),
    );
    // APIPromise parses lazily. Observe a clone so asResponse() keeps an unread
    // body, and await capture before returning through any public helper.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- OpenAI adds response helpers to its Promise subclass.
    const promise = result as Promise<OpenAIDecision> &
      Partial<OpenAIAPIPromise<OpenAIDecision>>;
    if (promise.asResponse) {
      const asResponse = promise.asResponse.bind(promise);
      const captured = asResponse().then(
        async (response) => {
          try {
            finish(await response.clone().json());
          } catch (error) {
            debugLogger.error("Error reading OpenAI decision response:", error);
            finish();
          }
        },
        (error) => finish(undefined, error),
      );
      const then = promise.then.bind(promise);
      // Start parsing only after cloning. OpenAI's parser otherwise runs
      // one microtask before asResponse() observers and locks the body.
      promise.then = (fulfilled, rejected) =>
        captured.then(() => then(fulfilled, rejected));
      promise.catch = (rejected) => promise.then(undefined, rejected);
      promise.finally = (callback) => promise.then().finally(callback);
      promise.asResponse = () => captured.then(() => asResponse());
      if (promise.withResponse) {
        const withResponse = promise.withResponse.bind(promise);
        promise.withResponse = () => captured.then(() => withResponse());
      }
    } else {
      void Promise.resolve(result).then(
        (value) => finish(value),
        (error) => finish(undefined, error),
      );
    }
    return result;
  } catch (error) {
    finish(undefined, error);
    throw error;
  }
}
