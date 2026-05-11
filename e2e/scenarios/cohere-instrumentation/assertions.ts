import { beforeAll, describe, expect, test } from "vitest";
import type { Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  matchFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunCohereScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    nodeArgs: string[];
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
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

function isCohereProviderLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("TooManyRequestsError") || message.includes("429");
}

function getOperationName(
  baseName: string,
  { useV2Namespace }: { useV2Namespace: boolean },
) {
  return useV2Namespace
    ? `cohere-v2-${baseName}-operation`
    : `cohere-${baseName}-operation`;
}

function buildSpanSummary(
  events: CapturedLogEvent[],
  supportsThinking: boolean,
  useV2Namespace: boolean,
): Json {
  const chatOperation = findLatestSpan(
    events,
    getOperationName("chat", { useV2Namespace }),
  );
  const chatStreamOperation = findLatestSpan(
    events,
    getOperationName("chat-stream", { useV2Namespace }),
  );
  const chatStreamThinkingOperation = findLatestSpan(
    events,
    getOperationName("chat-stream-thinking", { useV2Namespace }),
  );
  const embedOperation = findLatestSpan(
    events,
    getOperationName("embed", { useV2Namespace }),
  );
  const rerankOperation = findLatestSpan(
    events,
    getOperationName("rerank", { useV2Namespace }),
  );

  const summaryEvents = [
    findLatestSpan(events, ROOT_NAME),
    chatOperation,
    findCohereSpan(events, chatOperation?.span.id, "cohere.chat"),
    chatStreamOperation,
    findCohereSpan(events, chatStreamOperation?.span.id, "cohere.chatStream"),
    embedOperation,
    findCohereSpan(events, embedOperation?.span.id, "cohere.embed"),
    rerankOperation,
    findCohereSpan(events, rerankOperation?.span.id, "cohere.rerank"),
  ];

  if (supportsThinking) {
    summaryEvents.splice(
      5,
      0,
      chatStreamThinkingOperation,
      findCohereSpan(
        events,
        chatStreamThinkingOperation?.span.id,
        "cohere.chatStream",
      ),
    );
  }

  return summaryEvents.map((event) =>
    summarizeWrapperContract(event!, [
      "document_count",
      "inputType",
      "model",
      "operation",
      "provider",
      "scenario",
      "thinking",
      "topN",
    ]),
  ) as Json;
}

export function defineCohereInstrumentationAssertions(options: {
  name: string;
  runScenario: RunCohereScenario;
  snapshotName: string;
  supportsThinking: boolean;
  testFileUrl: string;
  timeoutMs: number;
  requireChatStreamOutput?: boolean;
  useV2Namespace?: boolean;
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
    let providerSkipReason: string | undefined;

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        try {
          await options.runScenario(harness);
        } catch (error) {
          if (isCohereProviderLimitError(error)) {
            providerSkipReason =
              "Cohere provider returned a rate or quota limit error";
            return;
          }

          throw error;
        }
        events = harness.events();
      });
    }, options.timeoutMs);

    test("captures the scenario root span", testConfig, (context) => {
      if (providerSkipReason) {
        context.skip();
      }

      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test("captures chat and chatStream spans", testConfig, (context) => {
      if (providerSkipReason) {
        context.skip();
      }

      const chatOperationName = getOperationName("chat", {
        useV2Namespace: options.useV2Namespace ?? false,
      });
      const chatStreamOperationName = getOperationName("chat-stream", {
        useV2Namespace: options.useV2Namespace ?? false,
      });
      const chatOperation = findLatestSpan(events, chatOperationName);
      const chatSpan = findCohereSpan(
        events,
        chatOperation?.span.id,
        "cohere.chat",
      );
      const chatStreamOperation = findLatestSpan(
        events,
        chatStreamOperationName,
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
      if (options.requireChatStreamOutput ?? true) {
        expect(chatStreamSpan?.output).toBeDefined();
      }
    });

    if (options.supportsThinking) {
      test(
        "captures reasoning content for chatStream",
        testConfig,
        (context) => {
          if (providerSkipReason) {
            context.skip();
          }

          const root = findLatestSpan(events, ROOT_NAME);
          const operation = findLatestSpan(
            events,
            getOperationName("chat-stream-thinking", {
              useV2Namespace: options.useV2Namespace ?? false,
            }),
          );
          const span = findCohereSpan(
            events,
            operation?.span.id,
            "cohere.chatStream",
          );
          const output = span?.output as
            | {
                content?: Array<{
                  text?: string;
                  thinking?: string;
                  type?: string;
                }>;
              }
            | undefined;
          const metrics = (span?.metrics ?? {}) as Record<string, unknown>;

          expect(operation).toBeDefined();
          expect(span).toBeDefined();
          expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
          expect(span?.row.metadata).toMatchObject({
            model: "command-a-reasoning-08-2025",
            provider: "cohere",
            thinking: {
              tokenBudget: 128,
              type: "enabled",
            },
          });
          expect(metrics).toMatchObject({
            completion_tokens: expect.any(Number),
            prompt_tokens: expect.any(Number),
            reasoning_tokens: expect.any(Number),
            time_to_first_token: expect.any(Number),
          });
          expect(
            output?.content?.some(
              (block) =>
                block.type === "thinking" && typeof block.thinking === "string",
            ),
          ).toBe(true);
          expect(
            output?.content?.some(
              (block) =>
                block.type === "text" && typeof block.text === "string",
            ),
          ).toBe(true);
        },
      );
    }

    test("captures embed span", testConfig, (context) => {
      if (providerSkipReason) {
        context.skip();
      }

      const operation = findLatestSpan(
        events,
        getOperationName("embed", {
          useV2Namespace: options.useV2Namespace ?? false,
        }),
      );
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

    test("captures rerank span", testConfig, (context) => {
      if (providerSkipReason) {
        context.skip();
      }

      const operation = findLatestSpan(
        events,
        getOperationName("rerank", {
          useV2Namespace: options.useV2Namespace ?? false,
        }),
      );
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

    test("matches span snapshot", testConfig, async (context) => {
      if (providerSkipReason) {
        context.skip();
      }

      await matchFileSnapshot(
        formatJsonFileSnapshot(
          buildSpanSummary(
            events,
            options.supportsThinking,
            options.useV2Namespace ?? false,
          ),
        ),
        spanSnapshotPath,
      );
    });
  });
}
