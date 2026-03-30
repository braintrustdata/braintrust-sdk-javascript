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

import {
  CHAT_MODEL,
  EMBEDDING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

const CHAT_MODEL_NAME = CHAT_MODEL.split("/").at(-1) ?? CHAT_MODEL;
const EMBEDDING_MODEL_NAME =
  EMBEDDING_MODEL.split("/").at(-1) ?? EMBEDDING_MODEL;
const OPENROUTER_MODEL_PROVIDER = "openai";

type RunOpenRouterScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function findOpenRouterSpans(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  for (const name of names) {
    const spans = findChildSpans(events, name, parentId);
    if (spans.length > 0) {
      return spans;
    }
  }

  return [];
}

function findOpenRouterSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  const spans = findOpenRouterSpans(events, parentId, names);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
  const chatOperation = findLatestSpan(events, "openrouter-chat-operation");
  const chatStreamOperation = findLatestSpan(
    events,
    "openrouter-chat-stream-operation",
  );
  const embeddingsOperation = findLatestSpan(
    events,
    "openrouter-embeddings-operation",
  );
  const responsesOperation = findLatestSpan(
    events,
    "openrouter-responses-operation",
  );
  const responsesStreamOperation = findLatestSpan(
    events,
    "openrouter-responses-stream-operation",
  );
  const callModelOperation = findLatestSpan(
    events,
    "openrouter-call-model-operation",
  );

  return [
    findLatestSpan(events, ROOT_NAME),
    chatOperation,
    findOpenRouterSpan(events, chatOperation?.span.id, [
      "openrouter.chat.send",
    ]),
    chatStreamOperation,
    findOpenRouterSpan(events, chatStreamOperation?.span.id, [
      "openrouter.chat.send",
    ]),
    embeddingsOperation,
    findOpenRouterSpan(events, embeddingsOperation?.span.id, [
      "openrouter.embeddings.generate",
    ]),
    responsesOperation,
    findOpenRouterSpan(events, responsesOperation?.span.id, [
      "openrouter.beta.responses.send",
    ]),
    responsesStreamOperation,
    findOpenRouterSpan(events, responsesStreamOperation?.span.id, [
      "openrouter.beta.responses.send",
    ]),
    callModelOperation,
    findOpenRouterSpan(events, callModelOperation?.span.id, [
      "openrouter.callModel",
    ]),
  ].map((event) =>
    summarizeWrapperContract(event!, [
      "embedding_model",
      "model",
      "operation",
      "provider",
      "scenario",
    ]),
  ) as Json;
}

export function defineOpenRouterTraceAssertions(options: {
  name: string;
  runScenario: RunOpenRouterScenario;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    "span-events.json",
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

    test("captures the root trace for the scenario", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test("captures trace for client.chat.send()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "openrouter-chat-operation");
      const span = findOpenRouterSpan(events, operation?.span.id, [
        "openrouter.chat.send",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.span.type).toBe("llm");
      expect(span?.row.metadata).toMatchObject({
        provider: OPENROUTER_MODEL_PROVIDER,
      });
      expect(span?.row.metadata?.model).toBe(CHAT_MODEL_NAME);
      expect(span?.output).toBeDefined();
    });

    test(
      "captures trace for client.chat.send({ stream: true })",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "openrouter-chat-stream-operation",
        );
        const span = findOpenRouterSpan(events, operation?.span.id, [
          "openrouter.chat.send",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          provider: OPENROUTER_MODEL_PROVIDER,
        });
        expect(span?.row.metadata?.model).toBe(CHAT_MODEL_NAME);
        expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
        expect(span?.output).toBeDefined();
      },
    );

    test("captures trace for client.embeddings.generate()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "openrouter-embeddings-operation",
      );
      const span = findOpenRouterSpan(events, operation?.span.id, [
        "openrouter.embeddings.generate",
      ]);
      const output = span?.output as { embedding_length?: number } | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        embedding_model: EMBEDDING_MODEL_NAME,
        provider: OPENROUTER_MODEL_PROVIDER,
      });
      expect(String(span?.row.metadata?.model)).toContain(EMBEDDING_MODEL_NAME);
      expect(output?.embedding_length).toEqual(expect.any(Number));
      expect(output?.embedding_length).toBeGreaterThan(0);
    });

    test("captures trace for client.beta.responses.send()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "openrouter-responses-operation",
      );
      const span = findOpenRouterSpan(events, operation?.span.id, [
        "openrouter.beta.responses.send",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        id: expect.any(String),
        provider: OPENROUTER_MODEL_PROVIDER,
        status: expect.any(String),
      });
      expect(String(span?.row.metadata?.model)).toContain(CHAT_MODEL_NAME);
      expect(span?.output).toBeDefined();
    });

    test("captures trace for streamed responses", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "openrouter-responses-stream-operation",
      );
      const span = findOpenRouterSpan(events, operation?.span.id, [
        "openrouter.beta.responses.send",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        id: expect.any(String),
        provider: OPENROUTER_MODEL_PROVIDER,
        status: expect.any(String),
      });
      expect(String(span?.row.metadata?.model)).toContain(CHAT_MODEL_NAME);
      expect(span?.metrics?.time_to_first_token).toEqual(expect.any(Number));
      expect(span?.output).toBeDefined();
    });

    test(
      "captures trace for client.callModel() and the nested tool call",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "openrouter-call-model-operation",
        );
        const span = findOpenRouterSpan(events, operation?.span.id, [
          "openrouter.callModel",
        ]);
        const nestedLlmSpans = findOpenRouterSpans(events, span?.span.id, [
          "openrouter.beta.responses.send",
        ]);
        const nestedToolSpan = findOpenRouterSpan(events, span?.span.id, [
          "lookup_weather",
          "openrouter.tool",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          provider: OPENROUTER_MODEL_PROVIDER,
        });
        expect(String(span?.row.metadata?.model)).toContain(CHAT_MODEL_NAME);
        expect(span?.output).toBeDefined();

        expect(nestedLlmSpans.length).toBeGreaterThanOrEqual(2);
        for (const [index, nestedLlmSpan] of nestedLlmSpans.entries()) {
          expect(nestedLlmSpan?.span.type).toBe("llm");
          expect(nestedLlmSpan?.row.metadata).toMatchObject({
            provider: OPENROUTER_MODEL_PROVIDER,
            step: index + 1,
          });
          expect(String(nestedLlmSpan?.row.metadata?.model)).toContain(
            CHAT_MODEL_NAME,
          );
          expect(nestedLlmSpan?.output).toBeDefined();
        }

        expect(nestedToolSpan).toBeDefined();
        expect(nestedToolSpan?.span.type).toBe("tool");
        expect(nestedToolSpan?.input).toMatchObject({
          city: "Vienna",
        });
        expect(nestedToolSpan?.row.metadata).toMatchObject({
          provider: "openrouter",
          tool_name: "lookup_weather",
        });
        expect(nestedToolSpan?.output).toMatchObject({
          forecast: "Sunny in Vienna",
        });
      },
    );

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events)),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });
  });
}
