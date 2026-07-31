import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  EMBEDDING_MODEL,
  GENERATION_MODEL,
  LEGACY_EMBEDDING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

type RunOllamaScenario = (harness: {
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

function findProviderSpan(
  events: CapturedLogEvent[],
  operationName: string,
  providerSpanName: string,
): CapturedLogEvent | undefined {
  const operation = findLatestSpan(events, operationName);
  const spans = findChildSpans(events, providerSpanName, operation?.span.id);
  return (
    spans.find(
      (candidate) =>
        candidate.output !== undefined || candidate.row.error !== undefined,
    ) ?? spans[0]
  );
}

function selectedEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const operations = [
    ["ollama-chat-operation", "ollama.chat"],
    ["ollama-chat-stream-operation", "ollama.chat"],
    ["ollama-generate-operation", "ollama.generate"],
    ["ollama-generate-stream-operation", "ollama.generate"],
    ["ollama-tool-call-operation", "ollama.chat"],
    ["ollama-embed-operation", "ollama.embed"],
    ["ollama-embeddings-operation", "ollama.embeddings"],
    ["ollama-error-operation", "ollama.chat"],
  ] as const;
  return [
    findLatestSpan(events, ROOT_NAME),
    ...operations.flatMap(([operationName, providerSpanName]) => [
      findLatestSpan(events, operationName),
      findProviderSpan(events, operationName, providerSpanName),
    ]),
  ].filter((event): event is CapturedLogEvent => event !== undefined);
}

function expectTokenMetrics(event: CapturedLogEvent | undefined): void {
  expect(event?.metrics).toMatchObject({
    prompt_tokens: expect.any(Number),
    completion_tokens: expect.any(Number),
    tokens: expect.any(Number),
  });
}

export function defineOllamaInstrumentationAssertions(options: {
  name: string;
  runScenario: RunOllamaScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
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
    }, options.timeoutMs);

    test("captures chat and generate calls with streaming parity", () => {
      for (const [operationName, spanName, streaming] of [
        ["ollama-chat-operation", "ollama.chat", false],
        ["ollama-chat-stream-operation", "ollama.chat", true],
        ["ollama-generate-operation", "ollama.generate", false],
        ["ollama-generate-stream-operation", "ollama.generate", true],
      ] as const) {
        const span = findProviderSpan(events, operationName, spanName);
        expect(span?.span.type).toBe("llm");
        expect(span?.row.metadata).toMatchObject({
          model: GENERATION_MODEL,
          provider: "ollama",
        });
        expect(span?.output).toEqual([
          expect.objectContaining({
            index: 0,
            finish_reason: expect.any(String),
            message: expect.objectContaining({
              role: "assistant",
              content: expect.any(String),
            }),
          }),
        ]);
        expectTokenMetrics(span);
        if (streaming) {
          expect(span?.metrics?.time_to_first_token).toEqual(
            expect.any(Number),
          );
        }
        expect(span?.row.context).toMatchObject({
          span_origin: {
            instrumentation: { name: "ollama" },
          },
        });
      }
    });

    test("captures canonical tool definitions and calls", () => {
      const span = findProviderSpan(
        events,
        "ollama-tool-call-operation",
        "ollama.chat",
      );
      const metadata = span?.row.metadata as
        | Record<string, unknown>
        | undefined;
      const output = span?.output as
        | Array<{
            finish_reason?: string;
            message?: {
              tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>
        | undefined;

      expect(metadata?.tools).toEqual([
        {
          type: "function",
          function: {
            name: "get_temperature",
            description: "Get the temperature for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ]);
      expect(output?.[0]?.finish_reason).toBe("tool_calls");
      expect(output?.[0]?.message?.tool_calls?.[0]).toMatchObject({
        id: "ollama_call_get_temperature_0",
        type: "function",
        function: {
          name: "get_temperature",
          arguments: '{"city":"Paris"}',
        },
      });
    });

    test("captures current and legacy embedding calls compactly", () => {
      const embed = findProviderSpan(
        events,
        "ollama-embed-operation",
        "ollama.embed",
      );
      const embeddings = findProviderSpan(
        events,
        "ollama-embeddings-operation",
        "ollama.embeddings",
      );

      expect(embed?.row.metadata).toMatchObject({
        model: EMBEDDING_MODEL,
        provider: "ollama",
      });
      expect(embed?.output).toEqual({ embedding_length: 4 });
      expect(embed?.metrics).toMatchObject({
        prompt_tokens: 4,
        tokens: 4,
      });

      expect(embeddings?.row.metadata).toMatchObject({
        model: LEGACY_EMBEDDING_MODEL,
        provider: "ollama",
      });
      expect(embeddings?.output).toEqual({ embedding_length: 3 });
    });

    test("captures provider errors without changing caller behavior", () => {
      const span = findProviderSpan(
        events,
        "ollama-error-operation",
        "ollama.chat",
      );
      expect(span?.row.error).toBe("synthetic Ollama failure");
    });

    test("captures the scenario root and matches the span tree", async () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
      await matchSpanTreeSnapshot(selectedEvents(events), snapshotPath);
    });
  });
}
