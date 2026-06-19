import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { MODEL, ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunBedrockRuntimeScenario = (harness: {
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

const OPERATION_TO_SPAN_NAME = {
  "bedrock-converse-operation": "bedrock.converse",
  "bedrock-converse-stream-operation": "bedrock.converseStream",
  "bedrock-invoke-model-operation": "bedrock.invokeModel",
  "bedrock-invoke-model-stream-operation":
    "bedrock.invokeModelWithResponseStream",
};

function findBedrockSpan(
  events: CapturedLogEvent[],
  operationName: keyof typeof OPERATION_TO_SPAN_NAME,
) {
  const operation = findLatestSpan(events, operationName);
  const spans = findChildSpans(
    events,
    OPERATION_TO_SPAN_NAME[operationName],
    operation?.span.id,
  );
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function spanTreeEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const root = findLatestSpan(events, ROOT_NAME);
  const items: CapturedLogEvent[] = root ? [root] : [];

  for (const operationName of Object.keys(OPERATION_TO_SPAN_NAME) as Array<
    keyof typeof OPERATION_TO_SPAN_NAME
  >) {
    const operation = findLatestSpan(events, operationName);
    const span = findBedrockSpan(events, operationName);
    if (operation) {
      items.push(operation);
    }
    if (span) {
      items.push(span);
    }
  }

  return items;
}

export function defineBedrockRuntimeInstrumentationAssertions(options: {
  name: string;
  runScenario: RunBedrockRuntimeScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
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

    test("captures Bedrock Runtime command spans", testConfig, () => {
      for (const operationName of Object.keys(OPERATION_TO_SPAN_NAME) as Array<
        keyof typeof OPERATION_TO_SPAN_NAME
      >) {
        const span = findBedrockSpan(events, operationName);
        expect(span, operationName).toBeDefined();
        expect(span?.row.metadata).toMatchObject({
          model: MODEL,
          provider: "aws-bedrock",
        });
        expect(span?.output).toBeDefined();
      }
    });

    test("captures token metrics for Converse calls", testConfig, () => {
      const converseSpan = findBedrockSpan(
        events,
        "bedrock-converse-operation",
      );
      const streamSpan = findBedrockSpan(
        events,
        "bedrock-converse-stream-operation",
      );

      expect(converseSpan?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
        tokens: expect.any(Number),
      });
      expect(streamSpan?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
        time_to_first_token: expect.any(Number),
        tokens: expect.any(Number),
      });
    });

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(spanTreeEvents(events), spanSnapshotPath);
    });
  });
}
