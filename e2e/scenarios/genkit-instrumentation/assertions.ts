import { beforeAll, describe, expect, test } from "vitest";
import type { Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";
import { MODEL_TOOL_MARKER, ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunGenkitScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function findGenkitSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  spanName: string,
) {
  const spans = findChildSpans(events, spanName, parentId);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function expectChildOf(
  child: CapturedLogEvent | undefined,
  parent: CapturedLogEvent | undefined,
) {
  expect(child?.span.parentIds).toContain(parent?.span.id);
}

function buildSpanSummary(
  events: CapturedLogEvent[],
  supportsActionSpans: boolean,
): Json {
  const flowOperation = findLatestSpan(events, "genkit-flow-operation");
  const flowSpan = supportsActionSpans
    ? findGenkitSpan(
        events,
        flowOperation?.span.id,
        "genkit.flow: instrumentationFlow",
      )
    : undefined;
  const generateOperation = findLatestSpan(events, "genkit-generate-operation");
  const streamOperation = findLatestSpan(events, "genkit-stream-operation");
  const embedOperation = findLatestSpan(events, "genkit-embed-operation");
  const modelToolOperation = findLatestSpan(
    events,
    "genkit-model-tool-operation",
  );
  const modelToolGenerateSpan = findGenkitSpan(
    events,
    modelToolOperation?.span.id,
    "genkit.generate",
  );
  const modelTriggeredToolSpan = supportsActionSpans
    ? findGenkitSpan(
        events,
        modelToolGenerateSpan?.span.id,
        "genkit.tool: cityMarkerTool",
      )
    : undefined;

  const summary = [
    findLatestSpan(events, ROOT_NAME),
    flowOperation,
    ...(supportsActionSpans ? [flowSpan] : []),
    generateOperation,
    findGenkitSpan(events, generateOperation?.span.id, "genkit.generate"),
    streamOperation,
    findGenkitSpan(events, streamOperation?.span.id, "genkit.generateStream"),
    embedOperation,
    findGenkitSpan(events, embedOperation?.span.id, "genkit.embed"),
    modelToolOperation,
    modelToolGenerateSpan,
    ...(supportsActionSpans ? [modelTriggeredToolSpan] : []),
  ];

  if (supportsActionSpans) {
    const toolOperation = findLatestSpan(events, "genkit-tool-operation");
    summary.push(
      toolOperation,
      findGenkitSpan(
        events,
        toolOperation?.span.id,
        "genkit.tool: summarizeCity",
      ),
    );
  }

  return summary.map((event) =>
    summarizeWrapperContract(event!, [
      "genkit.action_name",
      "genkit.action_type",
      "genkit.run_name",
      "model",
      "operation",
      "provider",
      "scenario",
    ]),
  ) as Json;
}

export function defineGenkitInstrumentationAssertions(options: {
  name: string;
  runScenario: RunGenkitScenario;
  snapshotName: string;
  supportsActionSpans: boolean;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-events.json`,
  );
  const testConfig = {
    timeout: options.timeoutMs,
  };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, options.timeoutMs);

    test("captures the scenario root span", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test("nests scenario operations under the flow span", testConfig, () => {
      const flowOperation = findLatestSpan(events, "genkit-flow-operation");
      expect(flowOperation).toBeDefined();

      const flowSpan = findGenkitSpan(
        events,
        flowOperation?.span.id,
        "genkit.flow: instrumentationFlow",
      );
      expectChildOf(flowSpan, flowOperation);

      for (const operationName of [
        "genkit-generate-operation",
        "genkit-stream-operation",
        "genkit-embed-operation",
        "genkit-tool-operation",
        "genkit-model-tool-operation",
      ]) {
        expectChildOf(findLatestSpan(events, operationName), flowSpan);
      }
    });

    test("captures generate, stream, and embed spans", testConfig, () => {
      const generateOperation = findLatestSpan(
        events,
        "genkit-generate-operation",
      );
      const generateSpan = findGenkitSpan(
        events,
        generateOperation?.span.id,
        "genkit.generate",
      );
      const streamOperation = findLatestSpan(events, "genkit-stream-operation");
      const streamSpan = findGenkitSpan(
        events,
        streamOperation?.span.id,
        "genkit.generateStream",
      );
      const embedOperation = findLatestSpan(events, "genkit-embed-operation");
      const embedSpan = findGenkitSpan(
        events,
        embedOperation?.span.id,
        "genkit.embed",
      );

      expect(generateSpan?.row.metadata).toMatchObject({
        provider: "genkit",
      });
      expect(generateSpan?.span.type).toBe("llm");
      expect(generateSpan?.metadata?.model).toEqual(
        expect.stringContaining("gemini-2.5-flash-lite"),
      );
      expect(generateSpan?.output).toBeDefined();
      expect(generateSpan?.metrics).toMatchObject({
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
        tokens: expect.any(Number),
      });

      expect(streamSpan?.row.metadata).toMatchObject({
        provider: "genkit",
      });
      expect(streamSpan?.span.type).toBe("llm");
      expect(streamSpan?.output).toBeDefined();
      expect(streamSpan?.metrics?.time_to_first_token).toEqual(
        expect.any(Number),
      );

      expect(embedSpan?.row.metadata).toMatchObject({
        provider: "genkit",
      });
      expect(embedSpan?.metadata?.model).toEqual(
        expect.stringContaining("gemini-embedding-001"),
      );
      expect(embedSpan?.output).toMatchObject({
        embedding_count: 1,
      });
    });

    test("captures a model-triggered tool call", testConfig, () => {
      const modelToolOperation = findLatestSpan(
        events,
        "genkit-model-tool-operation",
      );
      const generateSpan = findGenkitSpan(
        events,
        modelToolOperation?.span.id,
        "genkit.generate",
      );
      const toolSpan = findGenkitSpan(
        events,
        generateSpan?.span.id,
        "genkit.tool: cityMarkerTool",
      );

      expect(generateSpan?.row.metadata).toMatchObject({
        provider: "genkit",
      });
      expect(generateSpan?.span.type).toBe("llm");
      expect(generateSpan?.output).toBeDefined();
      expect(toolSpan?.row.metadata).toMatchObject({
        "genkit.action_name": "cityMarkerTool",
        "genkit.action_type": "tool",
        provider: "genkit",
      });
      expect(toolSpan?.output).toMatchObject({
        marker: MODEL_TOOL_MARKER,
      });
      expect(modelToolOperation?.output).toMatchObject({
        marker: MODEL_TOOL_MARKER,
        toolCalled: true,
      });
    });

    test.runIf(options.supportsActionSpans)(
      "captures tool and flow action spans",
      testConfig,
      () => {
        const toolOperation = findLatestSpan(events, "genkit-tool-operation");
        const toolSpan = findGenkitSpan(
          events,
          toolOperation?.span.id,
          "genkit.tool: summarizeCity",
        );
        const flowOperation = findLatestSpan(events, "genkit-flow-operation");
        const flowSpan = findGenkitSpan(
          events,
          flowOperation?.span.id,
          "genkit.flow: instrumentationFlow",
        );

        expect(toolSpan?.row.metadata).toMatchObject({
          "genkit.action_name": "summarizeCity",
          "genkit.action_type": "tool",
          provider: "genkit",
        });
        expect(toolSpan?.output).toMatchObject({
          summary: expect.any(String),
        });

        expect(flowSpan?.row.metadata).toMatchObject({
          "genkit.action_name": "instrumentationFlow",
          "genkit.action_type": "flow",
          provider: "genkit",
        });
        expect(flowSpan?.output).toMatchObject({
          completed: true,
        });
      },
    );

    test("matches span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(
          buildSpanSummary(events, options.supportsActionSpans),
        ),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });
  });
}
