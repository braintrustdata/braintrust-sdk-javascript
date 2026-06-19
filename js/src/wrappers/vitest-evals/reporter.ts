import type { Reporter, TestCase, TestModule, Vitest } from "vitest/node";
import { configureNode } from "../../node/config";
import {
  initExperiment,
  logError,
  type Experiment,
  type Span,
} from "../../logger";
import { SpanTypeAttribute, isObject } from "../../../util";
import { summarizeAndFlush } from "../shared/flush";

configureNode();

interface BraintrustVitestEvalsReporterOptions {
  projectName?: string;
  projectId?: string;
  experimentName?: string;
  displaySummary?: boolean;
  metadata?: Record<string, unknown>;
  tags?: string[];
  baseExperiment?: string;
  baseExperimentId?: string;
}

type EvalScore = {
  name?: string;
  score?: number | null;
  metadata?: Record<string, unknown>;
};

type EvalMeta = {
  scores?: EvalScore[];
  avgScore?: number | null;
  output?: unknown;
  thresholdFailed?: boolean;
  toolCalls?: ToolCallRecord[];
};

type HarnessMeta = {
  name?: string;
  run?: HarnessRun;
};

type EvalTaskMeta = {
  eval?: EvalMeta;
  harness?: HarnessMeta;
};

type HarnessRun = {
  output?: unknown;
  session?: {
    messages?: Array<{
      role?: string;
      content?: unknown;
      toolCalls?: ToolCallRecord[];
      metadata?: Record<string, unknown>;
    }>;
    provider?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    toolCalls?: number;
    retries?: number;
    provider?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  };
  timings?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
  traces?: NormalizedTrace[];
  errors?: Array<Record<string, unknown>>;
};

type ToolCallRecord = {
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

type NormalizedTrace = {
  id?: string;
  name?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  spans?: NormalizedSpan[];
};

type NormalizedSpan = {
  id?: string;
  traceId?: string;
  parentId?: string;
  name?: string;
  kind?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  status?: string;
  error?: unknown;
  attributes?: Record<string, unknown>;
  events?: unknown[];
};

type TestLike = Pick<
  TestCase,
  | "diagnostic"
  | "fullName"
  | "id"
  | "location"
  | "meta"
  | "name"
  | "result"
  | "tags"
> & {
  module?: Pick<TestModule, "moduleId" | "relativeModuleId">;
};

type EvalTestCandidate = {
  meta: EvalTaskMeta | undefined;
  test: TestLike;
};

type RunnableEvalTest = {
  meta: EvalTaskMeta;
  test: TestLike;
};

const RESERVED_NORMALIZED_SPAN_ATTRIBUTE_KEYS = new Set([
  "name",
  "type",
  "vitest_evals_kind",
  "trace_id",
  "external_span_id",
  "external_parent_id",
  "status",
]);

export default class BraintrustVitestEvalsReporter implements Reporter {
  private experiment?: Experiment;

  constructor(
    private readonly options: BraintrustVitestEvalsReporterOptions = {},
  ) {}

  onInit(_vitest: Vitest): void {
    // Vitest calls this before a run; keeping the hook declares reporter intent
    // while all data we need is available from onTestRunEnd.
  }

  async onTestRunEnd(testModules: ReadonlyArray<TestModule>): Promise<void> {
    const evalTests: RunnableEvalTest[] = [];
    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        const candidate = { test, meta: readEvalTaskMeta(test.meta()) };
        if (isRunnableEvalTest(candidate)) {
          evalTests.push(candidate);
        }
      }
    }

    if (evalTests.length === 0) {
      return;
    }

    const experiment = this.getOrCreateExperiment();

    for (const { test, meta } of evalTests) {
      logEvalTest(experiment, test, meta);
    }

    await summarizeAndFlush(experiment, {
      displaySummary: this.options.displaySummary,
    });
    this.experiment = undefined;
  }

  private getOrCreateExperiment(): Experiment {
    if (this.experiment) {
      return this.experiment;
    }

    const { projectId, projectName } = this.options;
    if (!projectId && !projectName) {
      throw new Error(
        "Braintrust vitest-evals reporter requires projectName or projectId when eval cases are reported.",
      );
    }

    const experimentName =
      this.options.experimentName ?? `vitest-evals-${new Date().toISOString()}`;

    this.experiment = initExperiment({
      ...(projectId ? { projectId } : { project: projectName }),
      experiment: experimentName,
      metadata: this.options.metadata,
      tags: this.options.tags,
      baseExperiment: this.options.baseExperiment,
      baseExperimentId: this.options.baseExperimentId,
    });

    return this.experiment;
  }
}

function isRunnableEvalTest(
  candidate: EvalTestCandidate,
): candidate is RunnableEvalTest {
  if (!candidate.meta) return false;

  const state = candidate.test.result().state;
  return state !== "skipped" && state !== "pending";
}

function logEvalTest(
  experiment: Experiment,
  test: TestLike,
  meta: EvalTaskMeta,
): void {
  const result = test.result();
  const diagnostic = test.diagnostic();
  const run = meta.harness?.run;
  const output = meta.eval?.output ?? run?.output;
  const scores = buildScores(result.state, meta.eval);
  const metrics = buildMetrics(diagnostic?.duration, run);
  const metadata = buildMetadata(test, meta, run);

  const rootSpan = experiment.startSpan({
    name: test.fullName || test.name,
    spanAttributes: {
      type: SpanTypeAttribute.EVAL,
      framework: "vitest",
      reporter: "vitest-evals",
    },
    startTime: startTimeSeconds(diagnostic),
    event: {
      input: {
        test: test.fullName || test.name,
        input: firstUserMessageContent(run),
      },
      ...(output !== undefined ? { output } : {}),
      scores,
      metrics,
      metadata,
      ...(test.tags.length > 0 ? { tags: test.tags } : {}),
    },
  });

  if (result.state === "failed") {
    for (const error of result.errors ?? []) {
      logReporterError(rootSpan, error);
    }
  }

  if (run?.traces?.length) {
    logNormalizedTraces(rootSpan, run.traces);
  } else {
    logToolCallSpans(rootSpan, toolCallsFromMeta(meta.eval, run));
  }

  rootSpan.end({
    endTime:
      startTimeSeconds(diagnostic) !== undefined &&
      diagnostic?.duration !== undefined
        ? startTimeSeconds(diagnostic)! + diagnostic.duration / 1000
        : undefined,
  });
}

function buildScores(
  state: ReturnType<TestLike["result"]>["state"],
  evalMeta: EvalMeta | undefined,
): Record<string, number | null> {
  const scores: Record<string, number | null> = {
    pass: state === "passed" ? 1 : 0,
  };

  if (typeof evalMeta?.avgScore === "number" || evalMeta?.avgScore === null) {
    scores.avg_score = evalMeta.avgScore;
  }

  for (const score of evalMeta?.scores ?? []) {
    if (!score.name) continue;
    if (typeof score.score === "number" || score.score === null) {
      scores[score.name] = score.score;
    }
  }

  return scores;
}

function buildMetrics(
  durationMs: number | undefined,
  run: HarnessRun | undefined,
): Record<string, unknown> {
  const usage = run?.usage;
  const metrics: Record<string, unknown> = {};

  if (durationMs !== undefined) {
    metrics.duration_ms = durationMs;
  }
  if (typeof usage?.inputTokens === "number") {
    metrics.input_tokens = usage.inputTokens;
  }
  if (typeof usage?.outputTokens === "number") {
    metrics.output_tokens = usage.outputTokens;
  }
  if (typeof usage?.reasoningTokens === "number") {
    metrics.reasoning_tokens = usage.reasoningTokens;
  }
  if (typeof usage?.totalTokens === "number") {
    metrics.total_tokens = usage.totalTokens;
  }
  if (typeof usage?.toolCalls === "number") {
    metrics.tool_calls = usage.toolCalls;
  }
  if (typeof usage?.retries === "number") {
    metrics.retries = usage.retries;
  }

  return metrics;
}

function buildMetadata(
  test: TestLike,
  meta: EvalTaskMeta,
  run: HarnessRun | undefined,
): Record<string, unknown> {
  const result = test.result();
  const metadata: Record<string, unknown> = {
    file: test.module?.moduleId,
    relativeFile: test.module?.relativeModuleId,
    fullName: test.fullName,
    testId: test.id,
    location: test.location,
    status: result.state,
    failureMessages: (result.errors ?? []).map(formatErrorMessage),
    harnessName: meta.harness?.name,
    thresholdFailed: meta.eval?.thresholdFailed,
    session: run?.session,
    artifacts: run?.artifacts,
    timings: run?.timings,
    errors: run?.errors,
    scoreMetadata: Object.fromEntries(
      (meta.eval?.scores ?? [])
        .filter((score) => score.name && score.metadata)
        .map((score) => [score.name!, score.metadata]),
    ),
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function logNormalizedTraces(rootSpan: Span, traces: NormalizedTrace[]): void {
  for (const trace of traces) {
    const spans = trace.spans ?? [];
    const spanMap = new Map<string, Span>();
    const pending = [...spans];

    while (pending.length > 0) {
      const before = pending.length;

      for (let index = pending.length - 1; index >= 0; index--) {
        const normalized = pending[index];
        const parent =
          normalized.parentId === undefined
            ? rootSpan
            : spanMap.get(normalized.parentId);

        if (!parent) continue;

        const span = logNormalizedSpan(parent, normalized, trace);
        if (normalized.id) {
          spanMap.set(normalized.id, span);
        }
        pending.splice(index, 1);
      }

      if (pending.length === before) {
        for (const normalized of pending.splice(0)) {
          const span = logNormalizedSpan(rootSpan, normalized, trace);
          if (normalized.id) {
            spanMap.set(normalized.id, span);
          }
        }
      }
    }
  }
}

function logNormalizedSpan(
  parent: Span,
  normalized: NormalizedSpan,
  trace: NormalizedTrace,
): Span {
  const span = parent.startSpan({
    name: normalized.name ?? normalized.kind ?? "harness span",
    spanAttributes: {
      ...filteredNormalizedSpanAttributes(normalized.attributes),
      type: spanTypeForNormalizedKind(normalized.kind),
      vitest_evals_kind: normalized.kind,
      trace_id: normalized.traceId ?? trace.id,
      external_span_id: normalized.id,
      external_parent_id: normalized.parentId,
      status: normalized.status,
    },
    startTime: epochSeconds(normalized.startedAt),
  });

  const metadata: Record<string, unknown> = {
    traceName: trace.name,
    traceMetadata: trace.metadata,
    events: normalized.events,
  };

  if (Object.values(metadata).some((value) => value !== undefined)) {
    span.log({
      metadata: Object.fromEntries(
        Object.entries(metadata).filter(([, value]) => value !== undefined),
      ),
    });
  }
  if (normalized.error !== undefined) {
    logReporterError(span, normalized.error);
  }

  span.end({ endTime: epochSeconds(normalized.finishedAt) });
  return span;
}

function logToolCallSpans(rootSpan: Span, calls: ToolCallRecord[]): void {
  for (const call of calls) {
    if (!call.name) continue;

    const span = rootSpan.startSpan({
      name: call.name,
      spanAttributes: {
        type: SpanTypeAttribute.TOOL,
        tool_call_id: call.id,
      },
      startTime: epochSeconds(call.startedAt),
      event: {
        input: call.arguments,
        ...(call.result !== undefined ? { output: call.result } : {}),
        metadata: call.metadata,
        metrics:
          call.durationMs !== undefined
            ? { duration_ms: call.durationMs }
            : undefined,
      },
    });

    if (call.error !== undefined) {
      logReporterError(span, call.error);
    }
    span.end({ endTime: epochSeconds(call.finishedAt) });
  }
}

function readEvalTaskMeta(input: unknown): EvalTaskMeta | undefined {
  if (!isObject(input)) return undefined;

  const evalMeta = readEvalMeta(input.eval);
  const harnessMeta = readHarnessMeta(input.harness);

  if (!evalMeta && !harnessMeta) return undefined;
  return {
    ...(evalMeta ? { eval: evalMeta } : {}),
    ...(harnessMeta ? { harness: harnessMeta } : {}),
  };
}

function readEvalMeta(input: unknown): EvalMeta | undefined {
  if (!isObject(input)) return undefined;

  const avgScore = readFiniteOrNull(input.avgScore);
  const scores = Array.isArray(input.scores)
    ? input.scores.map(readEvalScore).filter(isDefined)
    : undefined;
  const toolCalls = Array.isArray(input.toolCalls)
    ? input.toolCalls.map(readToolCall).filter(isDefined)
    : undefined;

  return {
    ...(scores ? { scores } : {}),
    ...(avgScore !== undefined ? { avgScore } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(typeof input.thresholdFailed === "boolean"
      ? { thresholdFailed: input.thresholdFailed }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function readEvalScore(input: unknown): EvalScore | undefined {
  if (!isObject(input)) return undefined;
  const score = readFiniteOrNull(input.score);
  return {
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(isObject(input.metadata) ? { metadata: input.metadata } : {}),
  };
}

function readHarnessMeta(input: unknown): HarnessMeta | undefined {
  if (!isObject(input)) return undefined;
  return {
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(isObject(input.run) ? { run: input.run } : {}),
  };
}

function readToolCall(input: unknown): ToolCallRecord | undefined {
  if (!isObject(input)) return undefined;
  return input;
}

function filteredNormalizedSpanAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!attributes) return {};

  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !RESERVED_NORMALIZED_SPAN_ATTRIBUTE_KEYS.has(key),
    ),
  );
}

function readFiniteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function firstUserMessageContent(run: HarnessRun | undefined): unknown {
  return run?.session?.messages?.find((message) => message.role === "user")
    ?.content;
}

function toolCallsFromRun(run: HarnessRun | undefined): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const message of run?.session?.messages ?? []) {
    if (Array.isArray(message.toolCalls)) {
      calls.push(...message.toolCalls);
    }
  }
  return calls;
}

function toolCallsFromMeta(
  evalMeta: EvalMeta | undefined,
  run: HarnessRun | undefined,
): ToolCallRecord[] {
  const runCalls = toolCallsFromRun(run);
  return runCalls.length > 0 ? runCalls : (evalMeta?.toolCalls ?? []);
}

function spanTypeForNormalizedKind(
  kind: string | undefined,
): SpanTypeAttribute {
  switch (kind) {
    case "model":
      return SpanTypeAttribute.LLM;
    case "tool":
      return SpanTypeAttribute.TOOL;
    case "agent":
    case "run":
      return SpanTypeAttribute.TASK;
    default:
      return SpanTypeAttribute.FUNCTION;
  }
}

function startTimeSeconds(
  diagnostic: ReturnType<TestLike["diagnostic"]> | undefined,
): number | undefined {
  return diagnostic?.startTime === undefined
    ? undefined
    : diagnostic.startTime / 1000;
}

function epochSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

function logReporterError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    logError(span, error);
    return;
  }

  if (isObject(error)) {
    const message =
      typeof error.message === "string" ? error.message : undefined;
    const stack = typeof error.stack === "string" ? error.stack : undefined;

    if (message !== undefined || stack !== undefined) {
      span.log({
        error: stack ? `${message ?? "<error>"}\n\n${stack}` : message,
      });
      return;
    }
  }

  logError(span, error);
}

function formatErrorMessage(error: unknown): string {
  if (isObject(error)) {
    if (typeof error.message === "string") return error.message;
    if (typeof error.stack === "string") return error.stack;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
