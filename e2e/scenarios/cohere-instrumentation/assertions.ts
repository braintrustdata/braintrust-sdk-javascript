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

type RunCohereScenario = (harness: {
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

function findCohereSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  spanName: string,
) {
  const spans = findChildSpans(events, spanName, parentId);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
  const chatOperation = findLatestSpan(events, "cohere-chat-operation");
  const chatStreamOperation = findLatestSpan(
    events,
    "cohere-chat-stream-operation",
  );
  const embedOperation = findLatestSpan(events, "cohere-embed-operation");
  const rerankOperation = findLatestSpan(events, "cohere-rerank-operation");

  return [
    findLatestSpan(events, ROOT_NAME),
    chatOperation,
    findCohereSpan(events, chatOperation?.span.id, "cohere.chat"),
    chatStreamOperation,
    findCohereSpan(events, chatStreamOperation?.span.id, "cohere.chatStream"),
    embedOperation,
    findCohereSpan(events, embedOperation?.span.id, "cohere.embed"),
    rerankOperation,
    findCohereSpan(events, rerankOperation?.span.id, "cohere.rerank"),
  ].map((event) =>
    summarizeWrapperContract(event!, [
      "document_count",
      "inputType",
      "model",
      "operation",
      "provider",
      "scenario",
      "topN",
    ]),
  ) as Json;
}

export function defineCohereInstrumentationAssertions(options: {
  name: string;
  runScenario: RunCohereScenario;
  snapshotName: string;
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

    test("captures chat and chatStream spans", testConfig, () => {
      const chatOperation = findLatestSpan(events, "cohere-chat-operation");
      const chatSpan = findCohereSpan(
        events,
        chatOperation?.span.id,
        "cohere.chat",
      );
      const chatStreamOperation = findLatestSpan(
        events,
        "cohere-chat-stream-operation",
      );
      const chatStreamSpan = findCohereSpan(
        events,
        chatStreamOperation?.span.id,
        "cohere.chatStream",
      );

      expect(chatOperation).toBeDefined();
      expect(chatSpan).toBeDefined();
      expect(chatSpan?.row.metadata).toMatchObject({
        provider: "cohere",
      });
      expect(chatSpan?.output).toBeDefined();

      expect(chatStreamOperation).toBeDefined();
      expect(chatStreamSpan).toBeDefined();
      expect(chatStreamSpan?.row.metadata).toMatchObject({
        provider: "cohere",
      });
      expect(chatStreamSpan?.output).toBeDefined();
    });

    test("captures embed span", testConfig, () => {
      const operation = findLatestSpan(events, "cohere-embed-operation");
      const span = findCohereSpan(events, operation?.span.id, "cohere.embed");
      const output = span?.output as { embedding_length?: number } | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(span?.row.metadata).toMatchObject({
        provider: "cohere",
      });
      expect(output?.embedding_length).toEqual(expect.any(Number));
      expect(output?.embedding_length).toBeGreaterThan(0);
    });

    test("captures rerank span", testConfig, () => {
      const operation = findLatestSpan(events, "cohere-rerank-operation");
      const span = findCohereSpan(events, operation?.span.id, "cohere.rerank");

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(span?.row.metadata).toMatchObject({
        provider: "cohere",
      });
      expect(Array.isArray(span?.output)).toBe(true);
      expect(span?.output?.[0]).toMatchObject({
        index: expect.any(Number),
        relevance_score: expect.any(Number),
      });
    });

    test("matches span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events)),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });
  });
}
