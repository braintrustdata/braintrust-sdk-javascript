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

const span = (overrides: Partial<MastraExportedSpan>): MastraExportedSpan => ({
  id: "span-1",
  traceId: "trace-1",
  name: "agent run",
  type: "agent_run",
  startTime: 1_000_000,
  ...overrides,
});

// Run a span through the exporter start->end and return the logged row.
async function logSpan(overrides: Partial<MastraExportedSpan>): Promise<any> {
  const exporter = new BraintrustObservabilityExporter();
  const exportedSpan = span({
    name: "llm: 'mock-model'",
    type: "model_generation",
    ...overrides,
  });
  await exporter.exportTracingEvent({ type: "span_started", exportedSpan });
  await exporter.exportTracingEvent({
    type: "span_ended",
    exportedSpan: { ...exportedSpan, endTime: 1_000_001 },
  });
  await backgroundLogger.flush();
  const events = (await backgroundLogger.drain()) as any[];
  return events.find((e) => e.span_attributes?.name === exportedSpan.name);
}

describe("BraintrustObservabilityExporter", () => {
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

describe("mastra thread-view IO transform", () => {
  test("unwraps model_generation input { messages } into a bare array", async () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const row = await logSpan({ input: { messages }, output: { text: "hi" } });
    expect(row?.input).toEqual(messages);
  });

  test("wraps a single model_generation input object into an array", async () => {
    const row = await logSpan({
      input: { role: "user", content: "Just this" },
      output: { text: "ok" },
    });
    expect(row?.input).toEqual([{ role: "user", content: "Just this" }]);
  });

  test("reshapes model_generation output text into an assistant message", async () => {
    const row = await logSpan({
      input: { messages: [{ role: "user", content: "Hi" }] },
      output: { text: "Hello there!", files: [], warnings: [] },
    });
    expect(row?.output).toEqual({
      role: "assistant",
      content: "Hello there!",
      files: [],
      warnings: [],
    });
  });

  test("passes through model_generation output that has no text (tool-call turn)", async () => {
    // A tool-call turn carries no `text`. Forcing `content: undefined` here
    // makes the downstream message importer drop the whole turn, so it must
    // pass through unchanged rather than be reshaped into an assistant message.
    const output = {
      files: [],
      reasoning: [],
      warnings: [],
      toolCalls: [{ toolCallId: "c1", toolName: "getWeather" }],
    };
    const row = await logSpan({
      input: { messages: [{ role: "user", content: "Weather?" }] },
      output,
    });
    expect(row?.output).toEqual(output);
    expect(row?.output).not.toHaveProperty("role");
    expect(row?.output).not.toHaveProperty("content");
  });

  test("assistant reshape wins over colliding fields in the raw output", async () => {
    const row = await logSpan({
      input: { messages: [{ role: "user", content: "Hi" }] },
      output: { text: "final", role: "tool", content: "stale", files: [] },
    });
    expect(row?.output).toEqual({
      role: "assistant",
      content: "final",
      files: [],
    });
  });

  test("leaves non-model spans untouched", async () => {
    const input = { messages: [{ role: "user", content: "Hi" }] };
    const output = { text: "raw" };
    const row = await logSpan({
      name: "tool call",
      type: "tool_call",
      input,
      output,
    });
    expect(row?.input).toEqual(input);
    expect(row?.output).toEqual(output);
  });

  // model_step and model_chunk are also `llm`-typed and reach Thread view, so
  // they get the same transform as model_generation.
  for (const type of ["model_step", "model_chunk"]) {
    test(`transforms ${type} input and output like model_generation`, async () => {
      const row = await logSpan({
        type,
        input: { messages: [{ role: "user", content: "Hi" }] },
        output: { text: "Hello there!", toolCalls: [] },
      });
      expect(row?.input).toEqual([{ role: "user", content: "Hi" }]);
      expect(row?.output).toEqual({
        role: "assistant",
        content: "Hello there!",
        toolCalls: [],
      });
    });
  }

  test("leaves rag_embedding spans untouched (llm-typed but not chat)", async () => {
    // rag_embedding maps to the `llm` span type but its payload is embedding
    // text/vectors, not chat messages, so it must not be reshaped.
    const input = { content: "text to embed" };
    const output = { text: "text to embed", embedding: [0.1, 0.2] };
    const row = await logSpan({ type: "rag_embedding", input, output });
    expect(row?.input).toEqual(input);
    expect(row?.output).toEqual(output);
  });
});
