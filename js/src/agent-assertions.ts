import type { EvalScorer, EvalScorerArgs } from "./framework";
import type { SpanData } from "./trace";
import type { BaseMetadata, DefaultMetadataType } from "./logger";
import type { Score } from "../util";
import { isPlainObject } from "./util";

type MaybePromise<T> = T | Promise<T>;

type AssertionMatcher =
  | RegExp
  | ((value: unknown) => boolean)
  | readonly AssertionMatcher[]
  | { [key: string]: AssertionMatcher }
  | string
  | number
  | boolean
  | null
  | undefined;

interface ToolCallAssertionOptions {
  /**
   * Match against the tool call input. Objects are matched partially, arrays
   * are matched recursively, regular expressions match raw strings as-is and
   * formatted non-string values, and functions are treated as predicates.
   */
  input?: AssertionMatcher;
  /**
   * Match against the tool call output. Objects are matched partially, arrays
   * are matched recursively, regular expressions match raw strings as-is and
   * formatted non-string values, and functions are treated as predicates.
   */
  output?: AssertionMatcher;
  /** If set, require the matching tool call to have, or not have, an error. */
  isError?: boolean;
  /** If set, require exactly this many matching calls. */
  times?: number;
}

interface AgentAssertion {
  name: string;
  evaluate: (resources: AgentAssertionResources) => MaybePromise<{
    passed: boolean;
    failure?: string;
  }>;
  requiresTrace?: boolean;
}

interface AgentAssertionHelpers {
  /**
   * Assert that two values are deeply equal.
   *
   * @param actual - The value produced by the task or derived by the scorer.
   * @param expected - The value to compare against.
   * @param name - Optional assertion name. Defaults to `"equals"`.
   */
  equals: (actual: unknown, expected: unknown, name?: string) => AgentAssertion;
  /**
   * Assert that two values are not deeply equal.
   *
   * @param actual - The value produced by the task or derived by the scorer.
   * @param expected - The value that should not be returned.
   * @param name - Optional assertion name. Defaults to `"not equals"`.
   */
  notEquals: (
    actual: unknown,
    expected: unknown,
    name?: string,
  ) => AgentAssertion;
  /**
   * Assert that a value contains a substring or matches a regular expression.
   * Regular expressions test raw strings as-is and formatted non-string values.
   *
   * @param value - The value to inspect.
   * @param expected - The substring or regular expression to find.
   * @param name - Optional assertion name. Defaults to `"contains"`.
   */
  contains: (
    value: unknown,
    expected: string | RegExp,
    name?: string,
  ) => AgentAssertion;
  /**
   * Assert that a value matches a schema.
   *
   * Supports schemas with `safeParse` or `parse`, such as Zod, and Standard
   * Schema `~standard.validate`, used by libraries such as Valibot and ArkType.
   *
   * @param value - The value to validate.
   * @param schema - The schema to validate against.
   * @param name - Optional assertion name. Defaults to `"matches schema"`.
   */
  matches: (
    value: unknown,
    schema: SchemaLike,
    name?: string,
  ) => AgentAssertion;
  /**
   * Assert that a tool was called, optionally constrained by input, output,
   * error state, or exact call count.
   *
   * @param toolName - The tool name to find in trace spans.
   * @param options - Optional constraints for matching calls.
   * @param name - Optional assertion name. Defaults to `"called tool ${toolName}"`.
   */
  calledTool: (
    toolName: string,
    options?: ToolCallAssertionOptions,
    name?: string,
  ) => AgentAssertion;
  /**
   * Assert that a tool was not called.
   *
   * @param toolName - The tool name to reject in trace spans.
   * @param name - Optional assertion name. Defaults to `"did not call tool ${toolName}"`.
   */
  notCalledTool: (toolName: string, name?: string) => AgentAssertion;
  /**
   * Assert that tools were called in the given relative order.
   *
   * The tools do not need to be adjacent. Extra tool calls between them are
   * allowed.
   *
   * @param toolNames - The ordered list of tool names to find.
   * @param name - Optional assertion name. Defaults to `"tool order"`.
   */
  toolOrder: (toolNames: string[], name?: string) => AgentAssertion;
  /**
   * Assert that the task made no tool calls.
   *
   * @param name - Optional assertion name. Defaults to `"used no tools"`.
   */
  usedNoTools: (name?: string) => AgentAssertion;
  /**
   * Assert that the task made no more than `max` tool calls.
   *
   * @param max - The maximum number of allowed tool calls.
   * @param name - Optional assertion name. Defaults to `"at most ${max} tool calls"`.
   */
  maxToolCalls: (max: number, name?: string) => AgentAssertion;
}

type AgentAssertionScorerCallback<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
> = (
  args: AgentAssertionScorerCallbackArgs<Input, Output, Expected, Metadata>,
) => MaybePromise<AgentAssertion[]>;

type AgentAssertionScorerCallbackArgs<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
> = Omit<
  EvalScorerArgs<Input, Output, Expected, Metadata>,
  "metadata" | "trace"
> & {
  /**
   * Row metadata passed to the Eval scorer. Defaults to an empty object when
   * the Eval row does not have typed metadata.
   */
  metadata: Metadata extends void ? Record<string, unknown> : Metadata;
  /** Helpers for building assertions from Eval inputs, outputs, and traces. */
  assert: AgentAssertionHelpers;
};

interface AgentAssertionResources {
  spans?: SpanData[];
}

type SchemaLike =
  | {
      safeParse: (value: unknown) => {
        success: boolean;
        error?: unknown;
      };
    }
  | {
      parse: (value: unknown) => unknown;
    }
  | {
      "~standard": {
        validate: (value: unknown) => MaybePromise<unknown>;
      };
    };

/**
 * Create an Eval scorer that will evaluate an agent based on assertions on the
 * generated trace.
 *
 * The callback receives `input`, `output`, `expected`, `metadata` plus an `assert`
 * helper object. It should return the assertions to evaluate the agent against.
 *
 * **Important**: Tool-call assertions require Braintrust tracing to be set up
 * during the Eval so the scorer can read tool spans from the trace.
 *
 * The score emitted by this scorer is the fraction of assertions that passed. If there are no
 * assertions, the score is `1`. The score metadata includes every assertion's name and
 * pass/fail state, plus human-readable failure messages.
 *
 * @example
 * ```ts
 * import { Eval, agentAssertionScorer } from "braintrust";
 *
 * await Eval("agent-eval", {
 *   data: () => [{ input: "What is the capital of Estonia?" }],
 *   task: async () => ({ answer: "Tallinn is the capital of Estonia." }),
 *   scores: [
 *     agentAssertionScorer(({ output, assert }) => [
 *       assert.contains(output.answer, /Tallinn/i, "mentions Tallinn"),
 *       assert.calledTool("web_search", { times: 1 }, "searched once"),
 *       assert.maxToolCalls(3, "bounded tool use"),
 *     ]),
 *   ],
 * });
 * ```
 */
export function agentAssertionScorer<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
>(
  callback: AgentAssertionScorerCallback<Input, Output, Expected, Metadata>,
  options: {
    /** The score name to emit. Defaults to `"assertions"`. */
    name?: string;
  } = {},
): EvalScorer<Input, Output, Expected, Metadata> {
  return async (args) => {
    const { trace: _trace, ...callbackArgs } = args;
    const callbackMetadata =
      (callbackArgs as { metadata?: unknown }).metadata ?? {};
    const assertions = await callback({
      ...callbackArgs,
      metadata: callbackMetadata,
      assert: agentAssertionHelpers,
    } as AgentAssertionScorerCallbackArgs<Input, Output, Expected, Metadata>);
    const resources: AgentAssertionResources = {};
    if (assertions.some((assertion) => assertion.requiresTrace)) {
      resources.spans = await args.trace?.getSpans({ spanType: ["tool"] });
    }

    const results = await Promise.all(
      assertions.map(async (assertion) => {
        const result = await assertion.evaluate(resources);
        return {
          name: assertion.name,
          passed: result.passed,
          failure: result.failure,
        };
      }),
    );

    const passed = results.filter((result) => result.passed).length;
    const total = results.length;
    const failed = results
      .filter((result) => !result.passed)
      .map(
        (result) =>
          `${result.name}: ${result.failure ?? "assertion did not pass"}`,
      );

    return {
      name: options.name ?? "assertions",
      score: total === 0 ? 1 : passed / total,
      metadata: {
        assertions: results.map(({ name, passed }) => ({ name, passed })),
        failed,
      },
    } satisfies Score;
  };
}

const agentAssertionHelpers: AgentAssertionHelpers = {
  equals: (actual, expected, name = "equals") => ({
    name,
    evaluate: () => {
      const passed = deepEqual(actual, expected);
      return {
        passed,
        failure: passed
          ? undefined
          : `expected ${formatValue(actual)} to equal ${formatValue(expected)}`,
      };
    },
  }),
  notEquals: (actual, expected, name = "not equals") => ({
    name,
    evaluate: () => {
      const passed = !deepEqual(actual, expected);
      return {
        passed,
        failure: passed
          ? undefined
          : `expected ${formatValue(actual)} not to equal ${formatValue(expected)}`,
      };
    },
  }),
  contains: (value, expected, name = "contains") => ({
    name,
    evaluate: () => {
      const searchedValue =
        typeof value === "string" ? value : formatValue(value);
      const passed =
        expected instanceof RegExp
          ? testRegex(expected, value)
          : searchedValue.includes(expected);
      return {
        passed,
        failure: passed
          ? undefined
          : `expected ${formatValue(value)} to contain ${formatValue(expected)}`,
      };
    },
  }),
  matches: (value, schema, name = "matches schema") => ({
    name,
    evaluate: async () => {
      const result = await validateSchema(schema, value);
      return {
        passed: result.passed,
        failure: result.passed
          ? undefined
          : `expected value to match schema: ${result.message}`,
      };
    },
  }),
  calledTool: (toolName, options = {}, name = `called tool ${toolName}`) => ({
    name,
    requiresTrace: true,
    evaluate: ({ spans }) => {
      const calls = matchingToolCalls(spans ?? [], toolName, options);
      const passed =
        options.times === undefined
          ? calls.length > 0
          : calls.length === options.times;
      return {
        passed,
        failure: passed
          ? undefined
          : options.times === undefined
            ? `expected tool "${toolName}" to be called; found ${calls.length} matching call${calls.length === 1 ? "" : "s"}`
            : `expected tool "${toolName}" to be called ${options.times} time${options.times === 1 ? "" : "s"}; found ${calls.length} matching call${calls.length === 1 ? "" : "s"}`,
      };
    },
  }),
  notCalledTool: (toolName, name = `did not call tool ${toolName}`) => ({
    name,
    requiresTrace: true,
    evaluate: ({ spans }) => {
      // This negative assertion treats an unavailable trace as "no observed
      // tool calls" on purpose. It lets users run the scorer for tasks that do
      // not collect traces without turning the absence of tracing itself into a
      // failure. Positive tool assertions still fail because they cannot find
      // the required call.
      const calls = toolCalls(spans ?? []).filter(
        (span) => getToolName(span) === toolName,
      );
      const passed = calls.length === 0;
      return {
        passed,
        failure: passed
          ? undefined
          : `expected tool "${toolName}" not to be called; found ${calls.length} call${calls.length === 1 ? "" : "s"}`,
      };
    },
  }),
  toolOrder: (toolNames, name = "tool order") => ({
    name,
    requiresTrace: true,
    evaluate: ({ spans }) => {
      const observed = toolCalls(spans ?? [])
        .map(getToolName)
        .filter((toolName) => toolName !== undefined);
      let fromIndex = 0;
      const passed = toolNames.every((toolName) => {
        const index = observed.indexOf(toolName, fromIndex);
        if (index === -1) return false;
        fromIndex = index + 1;
        return true;
      });
      return {
        passed,
        failure: passed
          ? undefined
          : `expected tool order ${toolNames.join(" -> ")}; observed ${observed.join(" -> ") || "no tools"}`,
      };
    },
  }),
  usedNoTools: (name = "used no tools") => ({
    name,
    requiresTrace: true,
    evaluate: ({ spans }) => {
      // This is intentionally based on observed tool calls: if no trace is
      // available, there are no observed calls, so this negative assertion
      // passes instead of treating missing tracing as a scorer failure.
      const calls = toolCalls(spans ?? []);
      const passed = calls.length === 0;
      return {
        passed,
        failure: passed
          ? undefined
          : `expected no tool calls; found ${calls.length}`,
      };
    },
  }),
  maxToolCalls: (max, name = `at most ${max} tool calls`) => ({
    name,
    requiresTrace: true,
    evaluate: ({ spans }) => {
      // Limit checks intentionally use the same "observed tool calls" model as
      // usedNoTools: without trace data, the observed count is zero. This keeps
      // missing tracing distinct from a task that actually exceeded the limit.
      const calls = toolCalls(spans ?? []);
      const passed = calls.length <= max;
      return {
        passed,
        failure: passed
          ? undefined
          : `expected at most ${max} tool call${max === 1 ? "" : "s"}; found ${calls.length}`,
      };
    },
  }),
};

async function validateSchema(
  schema: SchemaLike,
  value: unknown,
): Promise<{ passed: boolean; message: string }> {
  try {
    if ("safeParse" in schema) {
      const result = schema.safeParse(value);
      return result.success
        ? { passed: true, message: "" }
        : { passed: false, message: formatSchemaError(result.error) };
    }
    if ("parse" in schema) {
      schema.parse(value);
      return { passed: true, message: "" };
    }
    const result = await schema["~standard"].validate(value);
    if (
      typeof result === "object" &&
      result !== null &&
      "issues" in result &&
      Array.isArray(result.issues) &&
      result.issues.length > 0
    ) {
      return { passed: false, message: formatValue(result.issues) };
    }
    return { passed: true, message: "" };
  } catch (e) {
    return { passed: false, message: formatSchemaError(e) };
  }
}

function toolCalls(spans: SpanData[]) {
  return spans.filter((span) => span.span_attributes?.type === "tool");
}

function matchingToolCalls(
  spans: SpanData[],
  toolName: string,
  options: ToolCallAssertionOptions,
) {
  return toolCalls(spans).filter((span) => {
    if (getToolName(span) !== toolName) return false;
    if (
      Object.prototype.hasOwnProperty.call(options, "input") &&
      !matchesValue(span.input, options.input)
    ) {
      return false;
    }
    if (
      Object.prototype.hasOwnProperty.call(options, "output") &&
      !matchesValue(span.output, options.output)
    ) {
      return false;
    }
    if (
      options.isError !== undefined &&
      Boolean(span.error) !== options.isError
    ) {
      return false;
    }
    return true;
  });
}

function getToolName(span: SpanData) {
  const spanName = [span.span_attributes?.name, span.name]
    .map(normalizeToolName)
    .find((value): value is string => value !== undefined);
  if (spanName?.includes("/")) {
    return spanName;
  }

  const metadataName = [
    span.metadata?.tool_name,
    span.metadata?.["gen_ai.tool.name"],
  ]
    .map(normalizeToolName)
    .find((value): value is string => value !== undefined);
  const mcpServer = [
    span.metadata?.["mcp.server"],
    span.metadata?.["openai_codex.mcp.server"],
  ].find((value): value is string => typeof value === "string" && value !== "");

  if (metadataName && mcpServer) {
    return `${mcpServer}/${metadataName}`;
  }

  return metadataName ?? spanName;
}

function normalizeToolName(value: unknown) {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return value.startsWith("tool:") ? value.slice("tool:".length).trim() : value;
}

function matchesValue(actual: unknown, matcher: AssertionMatcher): boolean {
  if (matcher instanceof RegExp) {
    return testRegex(matcher, actual);
  }
  if (typeof matcher === "function") {
    return matcher(actual);
  }
  if (Array.isArray(matcher)) {
    return (
      Array.isArray(actual) &&
      actual.length === matcher.length &&
      matcher.every((value, index) => matchesValue(actual[index], value))
    );
  }
  if (isPlainObject(matcher) && isPlainObject(actual)) {
    return Object.entries(matcher).every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(actual, key) &&
        matchesValue(actual[key], value),
    );
  }
  return deepEqual(actual, matcher);
}

function testRegex(matcher: RegExp, value: unknown) {
  matcher.lastIndex = 0;
  return matcher.test(typeof value === "string" ? value : formatValue(value));
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) &&
          deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function formatSchemaError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return formatValue(error);
}

function formatValue(value: unknown) {
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && !hasUndefinedJsonValue(value)) {
      return serialized;
    }
    return formatValueWithUndefined(value, new Set());
  } catch {
    return String(value);
  }
}

function hasUndefinedJsonValue(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return Array.from({ length: value.length }).some((_, index) =>
      hasUndefinedJsonValue(value[index], seen),
    );
  }

  return Object.keys(value).some((key) =>
    hasUndefinedJsonValue((value as Record<string, unknown>)[key], seen),
  );
}

function formatValueWithUndefined(value: unknown, seen: Set<object>): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "function") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return '"[Circular]"';
  }

  seen.add(value);
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    const jsonValue = (value as { toJSON: () => unknown }).toJSON();
    seen.delete(value);
    return formatValueWithUndefined(jsonValue, seen);
  }
  if (Array.isArray(value)) {
    const formatted = Array.from({ length: value.length }, (_, index) =>
      formatValueWithUndefined(value[index], seen),
    );
    seen.delete(value);
    return `[${formatted.join(",")}]`;
  }

  const formatted = Object.keys(value).map(
    (key) =>
      `${JSON.stringify(key)}:${formatValueWithUndefined(
        (value as Record<string, unknown>)[key],
        seen,
      )}`,
  );
  seen.delete(value);
  return `{${formatted.join(",")}}`;
}
