import { debugLogger } from "../../debug-logger";
import { startSpan, withCurrent, type Span } from "../../logger";
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

// Object keys cannot distinguish boolean true from string "true". Boolean
// choices become `true` or `false`, prefixed with `boolean:` while that collides
// with a string choice, keeping criteria, selected choices and probabilities
// aligned. Matches the Python SDK and the Braintrust gateway.
function choiceKeys(
  values: (string | boolean)[],
): Map<string | boolean, string> {
  const strings = new Set(
    values.filter((value): value is string => typeof value === "string"),
  );
  return new Map(
    values.map((value): [string | boolean, string] => {
      if (typeof value === "string") return [value, value];
      let key = String(value);
      while (strings.has(key)) key = `boolean:${key}`;
      return [value, key];
    }),
  );
}

// Each question's span ID: its name, or `question_{index}` when the name is
// missing, empty, or already used. Matches the Python SDK and the Braintrust
// gateway.
function questionIds(questions: { name?: string | null }[]): string[] {
  const names = new Set(
    questions.flatMap(({ name }) => (typeof name === "string" ? [name] : [])),
  );
  const used = new Set<string>();
  return questions.map(({ name }, index) => {
    let id = name;
    if (typeof id !== "string" || !id || used.has(id)) {
      id = `question_${index}`;
      while (names.has(id) || used.has(id)) id += "_";
    }
    used.add(id);
    return id;
  });
}

// Pair each answer with its question as the Python SDK does: answers whose name
// is a question's ID claim that question first, and the rest pair with the
// remaining questions in order. Answers left without a question are dropped.
function decisionAnswers<
  Answer extends { name?: string | null },
  Question extends { name?: string | null },
>(
  answers: Answer[],
  questions: Question[],
): { id: string; answer: Answer; question: Question }[] {
  const ids = questionIds(questions);
  const named = new Map<string, Question>();
  ids.forEach((id, index) => {
    if (questions[index].name === id) named.set(id, questions[index]);
  });
  const claimed = new Set(
    answers.flatMap(({ name }) =>
      typeof name === "string" && named.has(name) ? [name] : [],
    ),
  );
  const remaining = ids
    .flatMap((id, index) =>
      claimed.has(id) ? [] : [{ id, question: questions[index] }],
    )
    .values();
  return answers.flatMap((answer) => {
    const name = answer.name;
    const question = typeof name === "string" ? named.get(name) : undefined;
    if (typeof name === "string" && question !== undefined) {
      named.delete(name);
      return [{ id: name, answer, question }];
    }
    const next = remaining.next();
    return next.done ? [] : [{ ...next.value, answer }];
  });
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
    const ids = questionIds(params.questions);
    const { name, spanAttributes, spanInfoMetadata } = buildStartSpanArgs(
      { name: "openai.decisions.create", type: "decision" },
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
                  id: ids[index],
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
                  criteria: question.levels.map(({ label, description }) =>
                    description === undefined
                      ? { label }
                      : { label, description },
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
        const pairs = decisionAnswers(value.answers, args[0].questions);
        const answers = pairs.map(({ id, answer, question }) => {
          const { name: _name, ...rest } = answer;
          if (rest.type === "predicate")
            return { id, type: "boolean", probability: rest.probability };
          if (rest.type === "choice") {
            const keys = choiceKeys(
              question.type === "choice"
                ? question.choices.map((choice) => choice.value)
                : rest.probabilities.map((entry) => entry.value),
            );
            return {
              id,
              ...rest,
              choice: keys.get(rest.choice) ?? String(rest.choice),
              probabilities: Object.fromEntries(
                rest.probabilities.map((entry) => [
                  keys.get(entry.value) ?? String(entry.value),
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
