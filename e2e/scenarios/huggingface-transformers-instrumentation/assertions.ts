import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";

import { ROOT_NAME } from "./scenario.impl.mjs";

type RunScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const EXPECTED_SPANS = [
  "huggingface.transformers.text_generation",
  "huggingface.transformers.text2text_generation",
  "huggingface.transformers.summarization",
  "huggingface.transformers.feature_extraction",
  "huggingface.transformers.question_answering",
];

export function defineAssertions(options: {
  name: string;
  runScenario: RunScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const testConfig = { timeout: options.timeoutMs };

  describe(options.name, () => {
    let traceEvents: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        const events = harness.events();
        const root = findLatestSpan(events, ROOT_NAME);
        expect(root, "missing scenario root").toBeDefined();
        traceEvents = events.filter(
          (event) => event.span.rootId === root?.span.rootId,
        );
      });
    }, options.timeoutMs);

    test("captures all supported local pipeline executions", testConfig, () => {
      for (const name of EXPECTED_SPANS) {
        const matches = traceEvents.filter((event) => event.span.name === name);
        expect(matches, `expected one ${name} span`).toHaveLength(1);
        expect(matches[0]?.span.type).toBe("llm");
        expect(matches[0]?.metadata).toMatchObject({
          model: `fixture/${name.slice("huggingface.transformers.".length).replaceAll("_", "-")}`,
          provider: "huggingface",
        });
      }

      expect(
        findLatestSpan(
          traceEvents,
          "huggingface.transformers.feature_extraction",
        )?.output,
      ).toEqual({
        embedding_batch_count: 1,
        embedding_count: 1,
        embedding_length: 3,
      });
      expect(
        findLatestSpan(
          traceEvents,
          "huggingface.transformers.question_answering",
        )?.output,
      ).toEqual([
        {
          finish_reason: "stop",
          index: 0,
          message: {
            content: "Ada",
            role: "assistant",
          },
        },
      ]);
    });

    test("matches span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(traceEvents, snapshotPath);
    });
  });
}
