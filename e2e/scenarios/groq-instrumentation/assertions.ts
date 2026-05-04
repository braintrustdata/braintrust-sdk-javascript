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

type RunGroqScenario = (harness: {
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

function findGroqSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  spanName: string,
) {
  const spans = findChildSpans(events, spanName, parentId);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
  const chatOperation = findLatestSpan(events, "groq-chat-operation");
  const streamOperation = findLatestSpan(events, "groq-stream-operation");
  const toolOperation = findLatestSpan(events, "groq-tool-operation");

  return [
    findLatestSpan(events, ROOT_NAME),
    chatOperation,
    findGroqSpan(
      events,
      chatOperation?.span.id,
      "groq.chat.completions.create",
    ),
    streamOperation,
    findGroqSpan(
      events,
      streamOperation?.span.id,
      "groq.chat.completions.create",
    ),
    toolOperation,
    findGroqSpan(
      events,
      toolOperation?.span.id,
      "groq.chat.completions.create",
    ),
  ].map((event) =>
    summarizeWrapperContract(event!, [
      "model",
      "operation",
      "provider",
      "scenario",
      "temperature",
    ]),
  ) as Json;
}

export function defineGroqInstrumentationAssertions(options: {
  name: string;
  runScenario: RunGroqScenario;
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

    test("captures chat and stream spans", testConfig, () => {
      const chatOperation = findLatestSpan(events, "groq-chat-operation");
      const chatSpan = findGroqSpan(
        events,
        chatOperation?.span.id,
        "groq.chat.completions.create",
      );
      const streamOperation = findLatestSpan(events, "groq-stream-operation");
      const streamSpan = findGroqSpan(
        events,
        streamOperation?.span.id,
        "groq.chat.completions.create",
      );

      expect(chatSpan?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(chatSpan?.row.metadata?.model).toBeDefined();
      expect(chatSpan?.output).toBeDefined();

      expect(streamSpan?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(streamSpan?.row.metadata?.model).toBeDefined();
      expect(streamSpan?.output).toBeDefined();
      expect(streamSpan?.metrics).toMatchObject({
        time_to_first_token: expect.any(Number),
      });
    });

    test("captures tool calling span", testConfig, () => {
      const operation = findLatestSpan(events, "groq-tool-operation");
      const span = findGroqSpan(
        events,
        operation?.span.id,
        "groq.chat.completions.create",
      );

      expect(span?.row.metadata).toMatchObject({
        provider: "groq",
      });
      expect(span?.row.metadata?.model).toBeDefined();
      expect(span?.output?.[0]?.message?.tool_calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({
              name: "get_weather",
            }),
          }),
        ]),
      );
    });

    test("matches span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events)),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });
  });
}
