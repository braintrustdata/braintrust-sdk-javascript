import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findAllSpans, findLatestSpan } from "../../helpers/trace-selectors";

import { MODEL_IDS, ROOT_NAME } from "./scenario.impl.mjs";

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
  {
    name: "huggingface.transformers.text_generation",
    task: "text-generation",
  },
  {
    name: "huggingface.transformers.text2text_generation",
    task: "text2text-generation",
  },
  {
    name: "huggingface.transformers.summarization",
    task: "summarization",
  },
  {
    name: "huggingface.transformers.feature_extraction",
    task: "feature-extraction",
  },
  {
    name: "huggingface.transformers.question_answering",
    task: "question-answering",
  },
] as const;

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
      for (const { name, task } of EXPECTED_SPANS) {
        const matches = findAllSpans(traceEvents, name);
        expect(matches, `expected one ${name} span`).toHaveLength(1);
        expect(matches[0]?.span.type).toBe("llm");
        expect(matches[0]?.metadata).toMatchObject({
          model: MODEL_IDS[task],
          provider: "huggingface",
        });
      }

      expect(
        findLatestSpan(
          traceEvents,
          "huggingface.transformers.feature_extraction",
        )?.output,
      ).toEqual({
        embedding_count: 1,
        embedding_length: 32,
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
            content: "##ace wrote th",
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
