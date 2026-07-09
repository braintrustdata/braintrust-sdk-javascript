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

function makeSpan(overrides: Partial<MastraExportedSpan>): MastraExportedSpan {
  return {
    id: "span-1",
    traceId: "trace-1",
    name: "agent run",
    type: "agent_run",
    startTime: 1_000_000,
    ...overrides,
  };
}

describe("BraintrustObservabilityExporter tags", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({ projectId: "test-project-id", projectName: "mastra.test.ts" });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  // A span is only logged if it was started, so drive both lifecycle events.
  const runSpan = async (
    exporter: BraintrustObservabilityExporter,
    span: MastraExportedSpan,
  ) => {
    await exporter.exportTracingEvent({
      type: "span_started",
      exportedSpan: span,
    });
    await exporter.exportTracingEvent({
      type: "span_ended",
      exportedSpan: { ...span, endTime: 1_000_001 },
    });
  };

  test("tags surface as a top-level field on the root span only", async () => {
    const exporter = new BraintrustObservabilityExporter();
    await runSpan(
      exporter,
      makeSpan({ id: "root", isRootSpan: true, tags: ["production", "beta"] }),
    );
    await runSpan(
      exporter,
      makeSpan({
        id: "child",
        name: "tool call",
        type: "tool_call",
        isRootSpan: false,
        tags: ["should-not-appear"],
      }),
    );

    const rows = (await backgroundLogger.drain()) as any[];
    const byName = (name: string) =>
      rows.find((r) => r.span_attributes?.name === name);

    const root = byName("agent run");
    expect(root).toBeDefined();
    // Braintrust surfaces the top-level `tags` field as first-class tags.
    expect(root.tags).toEqual(["production", "beta"]);
    // Backward compatibility: prior releases mirrored tags under metadata, so
    // that mirror is retained alongside the first-class top-level field.
    expect(root.metadata?.tags).toEqual(["production", "beta"]);

    // Top-level `tags` are trace-level, so non-root spans carry none.
    const child = byName("tool call");
    expect(child).toBeDefined();
    expect(child.tags).toBeUndefined();
    // Backward compatibility: prior releases mirrored any span's tags under
    // metadata, regardless of root-ness, so that behavior is preserved here.
    expect(child.metadata?.tags).toEqual(["should-not-appear"]);
  });
});
