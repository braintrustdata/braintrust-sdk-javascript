import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunAnthropicBedrockScenario = (harness: {
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

function findAnthropicSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
) {
  const spans = findChildSpans(events, "anthropic.messages.create", parentId);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function expectAnthropicMetadata(
  metadata: Record<string, unknown> | undefined,
) {
  expect(metadata).toMatchObject({
    provider: "anthropic",
  });
  expect(typeof metadata?.model).toBe("string");
  expect(metadata).not.toHaveProperty("bedrock");
  expect(metadata).not.toHaveProperty("awsRegion");
  expect(metadata).not.toHaveProperty("aws_region");
  expect(metadata).not.toHaveProperty("region");
}

function spanTreeEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const createOperation = findLatestSpan(
    events,
    "anthropic-bedrock-create-operation",
  );
  const streamOperation = findLatestSpan(
    events,
    "anthropic-bedrock-stream-operation",
  );

  return [
    findLatestSpan(events, ROOT_NAME),
    createOperation,
    findAnthropicSpan(events, createOperation?.span.id),
    streamOperation,
    findAnthropicSpan(events, streamOperation?.span.id),
  ].map((event) => event!);
}

export function defineAnthropicBedrockInstrumentationAssertions(options: {
  name: string;
  runScenario: RunAnthropicBedrockScenario;
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

    test(
      "captures create and stream spans through the Anthropic contract",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const createOperation = findLatestSpan(
          events,
          "anthropic-bedrock-create-operation",
        );
        const createSpan = findAnthropicSpan(events, createOperation?.span.id);
        const streamOperation = findLatestSpan(
          events,
          "anthropic-bedrock-stream-operation",
        );
        const streamSpan = findAnthropicSpan(events, streamOperation?.span.id);

        expect(createOperation).toBeDefined();
        expect(createSpan).toBeDefined();
        expect(streamOperation).toBeDefined();
        expect(streamSpan).toBeDefined();
        expect(createOperation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(streamOperation?.span.parentIds).toEqual([root?.span.id ?? ""]);

        expectAnthropicMetadata(
          createSpan?.row.metadata as Record<string, unknown> | undefined,
        );
        expect(createSpan?.output).toBeDefined();

        expectAnthropicMetadata(
          streamSpan?.row.metadata as Record<string, unknown> | undefined,
        );
        expect(streamSpan?.output).toBeDefined();
        expect(streamSpan?.metrics).toMatchObject({
          completion_tokens: expect.any(Number),
          prompt_tokens: expect.any(Number),
          time_to_first_token: expect.any(Number),
        });
      },
    );

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(spanTreeEvents(events), spanSnapshotPath);
    });
  });
}
