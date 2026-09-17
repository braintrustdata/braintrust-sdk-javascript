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

type RunTypeSafeScenario = (harness: {
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

const OPERATIONS = ["typesafe-mixed-operation", "typesafe-raw-operation"];

function spanTreeEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  return [
    findLatestSpan(events, ROOT_NAME),
    ...OPERATIONS.flatMap((operationName) => {
      const operation = findLatestSpan(events, operationName);
      return [
        operation,
        findLatestChildSpan(events, "typesafe.systemOne", operation?.span.id),
      ];
    }),
  ].map((event) => event!);
}

export function defineTypeSafeInstrumentationAssertions(options: {
  name: string;
  runScenario: RunTypeSafeScenario;
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

    test("captures native questions and every structured answer", () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "typesafe-mixed-operation");
      const span = findLatestChildSpan(
        events,
        "typesafe.systemOne",
        operation?.span.id,
      );

      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
      expect(span?.span.type).toBe("llm");
      expect(span?.input).toMatchObject({
        state: { message: expect.any(String) },
        questions: {
          category: { type: "choice" },
          urgency: { type: "score" },
          duplicate_charge: { type: "noul" },
        },
      });
      expect(span?.output).toMatchObject({
        category: {
          type: "choice",
          choice: expect.any(String),
          confidence: expect.any(Number),
          probabilities: expect.any(Object),
        },
        urgency: {
          type: "score",
          score: expect.any(Number),
          confidence: expect.any(Number),
          legend: expect.any(Object),
          probabilities: expect.any(Object),
        },
        duplicate_charge: { type: "noul", noul: expect.any(Number) },
      });
      expect(span?.row.metadata).toMatchObject({
        model: expect.stringMatching(/^jev-/),
        provider: "typesafe",
      });
      expect(span?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
        tokens: expect.any(Number),
      });
    });

    test("captures output while preserving raw response access", () => {
      const operation = findLatestSpan(events, "typesafe-raw-operation");
      const span = findLatestChildSpan(
        events,
        "typesafe.systemOne",
        operation?.span.id,
      );

      expect(span?.input).toMatchObject({
        state: "The package arrived intact and on time.",
        questions: { positive: { type: "noul" } },
      });
      expect(span?.output).toMatchObject({
        positive: { type: "noul", noul: expect.any(Number) },
      });
      expect(span?.row.metadata).toMatchObject({
        model: "jev-1.13.0",
        provider: "typesafe",
      });
    });

    test("matches the span tree snapshot", async () => {
      await matchSpanTreeSnapshot(spanTreeEvents(events), spanSnapshotPath);
    });
  });
}
