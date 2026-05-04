import { beforeAll, describe, expect, test } from "vitest";
import type { Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunGenkitScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: { variantKey: string };
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

function buildSpanSummary(
  events: CapturedLogEvent[],
  supportsActionSpans: boolean,
): Json {
  const generateOperation = findLatestSpan(events, "genkit-generate-operation");
  const streamOperation = findLatestSpan(events, "genkit-stream-operation");
  const embedOperation = findLatestSpan(events, "genkit-embed-operation");

  const summary = [
    findLatestSpan(events, ROOT_NAME),
    generateOperation,
    findGenkitSpan(events, generateOperation?.span.id, "genkit.generate"),
    streamOperation,
    findGenkitSpan(events, streamOperation?.span.id, "genkit.generateStream"),
    embedOperation,
    findGenkitSpan(events, embedOperation?.span.id, "genkit.embed"),
  ];

  if (supportsActionSpans) {
    const toolOperation = findLatestSpan(events, "genkit-tool-operation");
    const flowOperation = findLatestSpan(events, "genkit-flow-operation");
    summary.push(
      toolOperation,
      findGenkitSpan(
        events,
        toolOperation?.span.id,
        "genkit.tool: summarizeCity",
      ),
      flowOperation,
      findGenkitSpan(events, flowOperation?.span.id, "genkit.flow: recipeFlow"),
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
      expect(generateSpan?.row.metadata?.model).toEqual(
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
      expect(streamSpan?.output).toBeDefined();
      expect(streamSpan?.metrics?.time_to_first_token).toEqual(
        expect.any(Number),
      );

      expect(embedSpan?.row.metadata).toMatchObject({
        provider: "genkit",
      });
      expect(embedSpan?.row.metadata?.model).toEqual(
        expect.stringContaining("gemini-embedding-001"),
      );
      expect(embedSpan?.output).toMatchObject({
        embedding_count: 1,
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
          "genkit.flow: recipeFlow",
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
          "genkit.action_name": "recipeFlow",
          "genkit.action_type": "flow",
          provider: "genkit",
        });
        expect(flowSpan?.output).toMatchObject({
          recipe: expect.any(String),
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
