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

type ExportedSpan = Parameters<
  BraintrustObservabilityExporter["exportTracingEvent"]
>[0]["exportedSpan"];

const span = (overrides: Partial<ExportedSpan>): ExportedSpan => ({
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
  });
});
