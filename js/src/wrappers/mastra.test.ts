import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { configureNode } from "../node/config";
import { _exportsForTestingOnly, initLogger } from "../logger";
import { BraintrustObservabilityExporter } from "./mastra";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

type MastraExportedSpan = Parameters<
  BraintrustObservabilityExporter["exportTracingEvent"]
>[0]["exportedSpan"];

const span = (overrides: Partial<MastraExportedSpan>): MastraExportedSpan => ({
  id: "span-1",
  traceId: "trace-1",
  name: "agent run",
  type: "agent_run",
  startTime: 1_000_000,
  ...overrides,
});

describe("BraintrustObservabilityExporter", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let logger: ReturnType<typeof initLogger>;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    logger = initLogger({
      projectId: "test-project-id",
      projectName: "mastra.test.ts",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("logFeedback keyed on the Mastra span id merges into the span row", async () => {
    const exporter = new BraintrustObservabilityExporter();
    const id = "mastra-span-123";

    await exporter.exportTracingEvent({
      type: "span_started",
      exportedSpan: span({ id }),
    });
    await exporter.exportTracingEvent({
      type: "span_ended",
      exportedSpan: span({ id, endTime: 1_000_001 }),
    });
    // A Mastra user (or Mastra's score-event bus) knows only the Mastra span id.
    logger.logFeedback({ id, scores: { quality: 0.9 }, source: "external" });

    await backgroundLogger.flush();
    const rows = (await backgroundLogger.drain()) as any[];

    // The exporter aliases the row id to the Mastra span id, so the feedback
    // merge row keys onto the span row and `mergeRowBatch` collapses them into a
    // single row carrying both the span and the score. Without the aliasing the
    // feedback would land as a separate orphan row.
    const merged = rows.filter((r) => r.id === id);
    expect(merged).toHaveLength(1);
    expect(merged[0].span_attributes?.name).toBe("agent run");
    expect(merged[0].scores?.quality).toBe(0.9);
    expect(merged[0].context?.span_origin).toMatchObject({
      instrumentation: { name: "mastra" },
    });
  });

  // Run a model span's full lifecycle through the exporter and return the logged
  // row. Both events are required: onEnd is a no-op without a prior onStart.
  async function logModelSpan(
    attributes: Record<string, unknown>,
  ): Promise<any> {
    const modelSpan = span({
      id: "span-1",
      traceId: "trace-1",
      name: "llm: 'mock-model'",
      type: "model_generation",
      startTime: 1_000_000_000,
      attributes,
    });
    const exporter = new BraintrustObservabilityExporter();
    await exporter.exportTracingEvent({
      type: "span_started",
      exportedSpan: modelSpan,
    });
    await exporter.exportTracingEvent({
      type: "span_ended",
      exportedSpan: { ...modelSpan, endTime: 1_000_000_005 },
    });
    await backgroundLogger.flush();
    const events = (await backgroundLogger.drain()) as any[];
    return events.find(
      (event) => event.span_attributes?.name === modelSpan.name,
    );
  }

  test("maps token usage and derives time_to_first_token in seconds", async () => {
    // Span starts at t=1_000_000_000ms; first token at +750ms → 0.75s TTFT.
    const row = await logModelSpan({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputDetails: { cacheRead: 40, cacheWrite: 10 },
        outputDetails: { reasoning: 20 },
      },
      completionStartTime: new Date(1_000_000_750),
    });

    expect(row?.metrics).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 50,
      tokens: 150,
      prompt_cached_tokens: 40,
      prompt_cache_creation_tokens: 10,
      completion_reasoning_tokens: 20,
    });
    expect(row?.metrics?.time_to_first_token).toBeCloseTo(0.75, 5);
    // completionStartTime feeds the TTFT metric, but the raw value stays in
    // metadata for backward compatibility (earlier releases surfaced it there).
    expect(row?.metadata?.completionStartTime).toBeDefined();
  });

  test("omits time_to_first_token for non-streaming spans", async () => {
    const row = await logModelSpan({
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(row?.metrics?.tokens).toBe(15);
    expect(row?.metrics?.time_to_first_token).toBeUndefined();
  });
});
