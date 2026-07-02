import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import BraintrustVitestEvalsReporter from "./reporter";
import { configureNode } from "../../node/config";
import {
  _exportsForTestingOnly,
  type TestBackgroundLogger,
} from "../../logger";
import * as logger from "../../logger";

configureNode();

let backgroundLogger: TestBackgroundLogger;

beforeAll(async () => {
  _exportsForTestingOnly.setInitialTestState();
  await _exportsForTestingOnly.simulateLoginForTests();
  backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();

  vi.spyOn(logger, "initExperiment").mockImplementation(
    (projectOrOptions: string | any, options?: any) => {
      const experimentOptions =
        typeof projectOrOptions === "string" ? options : projectOrOptions;
      const projectName =
        typeof projectOrOptions === "string"
          ? projectOrOptions
          : (projectOrOptions.project ??
            projectOrOptions.projectId ??
            "test-project");

      return _exportsForTestingOnly.initTestExperiment(
        experimentOptions?.experiment || "test-experiment",
        projectName,
      );
    },
  );
});

beforeEach(async () => {
  await backgroundLogger.drain();
});

describe("Braintrust vitest-evals reporter", () => {
  test("does nothing when no eval metadata is present", async () => {
    const reporter = new BraintrustVitestEvalsReporter();

    await reporter.onTestRunEnd([
      fakeModule([fakeTest({ meta: {}, name: "plain test" })]),
    ] as any);

    await backgroundLogger.flush();
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  test("requires a project only when eval cases are reported", async () => {
    const reporter = new BraintrustVitestEvalsReporter();

    await expect(
      reporter.onTestRunEnd([
        fakeModule([
          fakeTest({
            meta: { eval: { avgScore: 1 } },
            name: "eval test",
          }),
        ]),
      ] as any),
    ).rejects.toThrow("projectName or projectId");
  });

  test("logs eval metadata, usage metrics, and normalized traces", async () => {
    const reporter = new BraintrustVitestEvalsReporter({
      displaySummary: false,
      experimentName: "vitest-evals-unit-test",
      projectName: "vitest-evals-tests",
    });
    const module = fakeModule([
      fakeTest({
        diagnostic: { duration: 125, startTime: 1_700_000_000_000 },
        fullName: "refund eval > approves refund",
        location: { line: 42, column: 7 },
        meta: {
          eval: {
            avgScore: 0.9,
            output: { status: "approved" },
            scores: [
              {
                name: "FactualityJudge",
                score: 0.8,
                metadata: { rationale: "close enough" },
              },
            ],
          },
          harness: {
            name: "refund-harness",
            run: {
              session: {
                messages: [
                  { role: "user", content: "Refund invoice inv_123" },
                  {
                    role: "assistant",
                    content: { status: "approved" },
                  },
                ],
              },
              usage: {
                inputTokens: 10,
                outputTokens: 15,
                reasoningTokens: 2,
                totalTokens: 27,
                toolCalls: 1,
              },
              artifacts: { invoiceId: "inv_123" },
              traces: [
                {
                  id: "trace-1",
                  name: "refund trace",
                  spans: [
                    {
                      id: "model-1",
                      kind: "model",
                      name: "classify refund",
                      startedAt: "2026-01-01T00:00:00.000Z",
                      finishedAt: "2026-01-01T00:00:00.050Z",
                      attributes: {
                        "custom.attribute": "preserved",
                        "gen_ai.request.model": "gpt-test",
                        external_span_id: "user-external-span-id",
                        name: "user span name",
                        status: "user-status",
                        trace_id: "user-trace-id",
                        type: "custom",
                        vitest_evals_kind: "custom",
                      },
                    },
                    {
                      id: "tool-1",
                      parentId: "model-1",
                      kind: "tool",
                      name: "lookupInvoice",
                      startedAt: "2026-01-01T00:00:00.100Z",
                      durationMs: 12,
                      attributes: { "gen_ai.tool.name": "lookupInvoice" },
                    },
                  ],
                },
              ],
            },
          },
        },
        name: "approves refund",
        tags: ["refund", "happy-path"],
      }),
    ]);

    await reporter.onTestRunEnd([module] as any);
    await backgroundLogger.flush();
    const rows = await backgroundLogger.drain();

    const root = rows.find((row: any) => row.scores?.FactualityJudge === 0.8);
    expect(root).toMatchObject({
      input: {
        input: "Refund invoice inv_123",
        test: "refund eval > approves refund",
      },
      metrics: {
        duration_ms: 125,
        input_tokens: 10,
        output_tokens: 15,
        reasoning_tokens: 2,
        total_tokens: 27,
        tool_calls: 1,
      },
      output: { status: "approved" },
      scores: {
        avg_score: 0.9,
        FactualityJudge: 0.8,
        pass: 1,
      },
      tags: ["refund", "happy-path"],
    });
    expect(root?.metadata).toMatchObject({
      artifacts: { invoiceId: "inv_123" },
      file: "/repo/evals/refund.eval.ts",
      harnessName: "refund-harness",
      location: { line: 42, column: 7 },
      status: "passed",
      scoreMetadata: {
        FactualityJudge: { rationale: "close enough" },
      },
    });

    const modelSpan = rows.find(
      (row: any) => row.span_attributes?.name === "classify refund",
    );
    const toolSpan = rows.find(
      (row: any) => row.span_attributes?.name === "lookupInvoice",
    );

    expect(modelSpan?.span_attributes).toMatchObject({
      "custom.attribute": "preserved",
      "gen_ai.request.model": "gpt-test",
      name: "classify refund",
      type: "llm",
      vitest_evals_kind: "model",
      trace_id: "trace-1",
      external_span_id: "model-1",
    });
    expect(toolSpan?.span_attributes).toMatchObject({
      type: "tool",
      vitest_evals_kind: "tool",
      external_parent_id: "model-1",
    });
    expect(toolSpan?.span_parents).toEqual([modelSpan?.span_id]);
    expect(toolSpan?.metrics?.duration_ms).toBe(12);
    expect(toolSpan?.metrics?.start).toBe(
      Date.parse("2026-01-01T00:00:00.100Z") / 1000,
    );
    expect(toolSpan?.metrics?.end).toBeCloseTo(
      Date.parse("2026-01-01T00:00:00.100Z") / 1000 + 0.012,
      6,
    );
  });

  test("logs failed eval scores and failure metadata", async () => {
    const reporter = new BraintrustVitestEvalsReporter({
      displaySummary: false,
      projectName: "vitest-evals-tests",
    });

    await reporter.onTestRunEnd([
      fakeModule([
        fakeTest({
          meta: {
            eval: {
              avgScore: 0.4,
              output: { status: "denied" },
              scores: [{ name: "StatusJudge", score: 0 }],
              thresholdFailed: true,
            },
            harness: {
              run: {
                errors: [{ message: "application run failed" }],
                session: {
                  messages: [{ role: "user", content: "Refund inv_bad" }],
                },
                usage: {},
              },
            },
          },
          name: "failed eval",
          result: {
            errors: [
              {
                message: "expected score to meet threshold",
                stack: "AssertionError: expected score to meet threshold",
              },
            ],
            state: "failed",
          },
        }),
      ]),
    ] as any);

    await backgroundLogger.flush();
    const rows = await backgroundLogger.drain();
    const root = rows.find((row: any) => row.scores?.StatusJudge === 0);

    expect(root?.scores).toMatchObject({
      StatusJudge: 0,
      avg_score: 0.4,
      pass: 0,
    });
    expect(root?.metadata).toMatchObject({
      errors: [{ message: "application run failed" }],
      failureMessages: ["expected score to meet threshold"],
      status: "failed",
      thresholdFailed: true,
    });
    const errorRow = rows.find((row: any) => typeof row.error === "string");
    expect(errorRow?.error).toContain("expected score to meet threshold");
    expect(errorRow?.error).toContain(
      "AssertionError: expected score to meet threshold",
    );
    expect(errorRow?.error).not.toContain("[object Object]");
  });

  test("logs fallback tool spans when no normalized traces are present", async () => {
    const reporter = new BraintrustVitestEvalsReporter({
      displaySummary: false,
      projectId: "project-id",
    });

    await reporter.onTestRunEnd([
      fakeModule([
        fakeTest({
          meta: {
            eval: { avgScore: 1 },
            harness: {
              run: {
                output: "done",
                session: {
                  messages: [
                    {
                      role: "assistant",
                      toolCalls: [
                        {
                          name: "searchDocs",
                          arguments: { query: "refunds" },
                          result: { count: 2 },
                          startedAt: "2026-01-01T00:00:00.200Z",
                          durationMs: 12,
                        },
                      ],
                    },
                  ],
                },
                usage: {},
              },
            },
          },
          name: "tool fallback",
        }),
        fakeTest({
          meta: {
            eval: {
              avgScore: 1,
              toolCalls: [
                {
                  name: "lookupLegacy",
                  arguments: { id: "legacy" },
                  result: { ok: true },
                },
              ],
            },
            harness: {
              run: {
                output: "done",
                session: { messages: [] },
                usage: {},
              },
            },
          },
          name: "eval tool fallback",
        }),
      ]),
    ] as any);

    await backgroundLogger.flush();
    const rows = await backgroundLogger.drain();
    const toolSpan = rows.find(
      (row: any) => row.span_attributes?.name === "searchDocs",
    );
    const evalToolSpan = rows.find(
      (row: any) => row.span_attributes?.name === "lookupLegacy",
    );

    expect(toolSpan).toMatchObject({
      input: { query: "refunds" },
      metrics: { duration_ms: 12 },
      output: { count: 2 },
      span_attributes: { type: "tool" },
    });
    expect(toolSpan?.metrics?.start).toBe(
      Date.parse("2026-01-01T00:00:00.200Z") / 1000,
    );
    expect(toolSpan?.metrics?.end).toBeCloseTo(
      Date.parse("2026-01-01T00:00:00.200Z") / 1000 + 0.012,
      6,
    );
    expect(evalToolSpan).toMatchObject({
      input: { id: "legacy" },
      output: { ok: true },
      span_attributes: { type: "tool" },
    });
  });
});

function fakeModule(tests: any[]) {
  const module = {
    children: {
      allTests: function* () {
        yield* tests;
      },
    },
    moduleId: "/repo/evals/refund.eval.ts",
    relativeModuleId: "evals/refund.eval.ts",
  };

  for (const test of tests) {
    test.module = module;
  }

  return module;
}

function fakeTest({
  diagnostic = { duration: 50, startTime: 1_700_000_000_000 },
  fullName,
  location = { line: 1, column: 1 },
  meta,
  name,
  result = { state: "passed" },
  tags = [],
}: {
  diagnostic?: { duration: number; startTime: number };
  fullName?: string;
  location?: { line: number; column: number };
  meta: Record<string, unknown>;
  name: string;
  result?: { state: string; errors?: unknown[] };
  tags?: string[];
}) {
  return {
    diagnostic: () => diagnostic,
    fullName: fullName ?? name,
    id: `test:${name}`,
    location,
    meta: () => meta,
    name,
    result: () => result,
    tags,
  };
}
