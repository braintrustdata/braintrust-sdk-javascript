import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunVoyageAIScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
  }) => Promise<unknown>;
}) => Promise<void>;

const OPERATIONS = [
  {
    model: "voyage-4",
    metrics: { prompt_tokens: 4, tokens: 4 },
    operationName: "voyageai-embed-operation",
    output: { count: 1 },
    spanName: "voyageai.embed",
  },
  {
    model: "voyage-multimodal-3.5",
    metrics: { prompt_tokens: 6, tokens: 6 },
    operationName: "voyageai-multimodal-embed-operation",
    output: { count: 1 },
    spanName: "voyageai.multimodalEmbed",
  },
  {
    model: "rerank-2.5",
    metrics: { tokens: 11 },
    operationName: "voyageai-rerank-operation",
    output: [
      { index: 1, relevance_score: 0.97 },
      { index: 0, relevance_score: 0.21 },
    ],
    spanName: "voyageai.rerank",
  },
  {
    model: "voyage-context-3",
    metrics: { prompt_tokens: 8, tokens: 8 },
    operationName: "voyageai-contextualized-embed-operation",
    output: { count: 2 },
    spanName: "voyageai.contextualizedEmbed",
  },
] as const;

function spanTreeEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  return [
    findLatestSpan(events, ROOT_NAME),
    ...OPERATIONS.flatMap(({ operationName, spanName }) => {
      const operation = findLatestSpan(events, operationName);
      return [
        operation,
        findLatestChildSpan(events, spanName, operation?.span.id),
      ];
    }),
  ].map((event) => event!);
}

export function defineVoyageAIInstrumentationAssertions(options: {
  name: string;
  runScenario: RunVoyageAIScenario;
  snapshotName: string;
  testFileUrl: string;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    });

    test("captures the scenario root span", () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test.each(OPERATIONS)(
      "captures $spanName",
      ({ metrics, model, operationName, output, spanName }) => {
        const operation = findLatestSpan(events, operationName);
        const span = findLatestChildSpan(events, spanName, operation?.span.id);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(span?.span.type).toBe("llm");
        expect(span?.row.metadata).toMatchObject({
          model,
          provider: "voyage",
        });
        expect(span?.metrics).toMatchObject(metrics);
        expect(span?.output).toEqual(output);
      },
    );

    test("matches the span tree snapshot", async () => {
      await matchSpanTreeSnapshot(spanTreeEvents(events), spanSnapshotPath);
    });
  });
}
