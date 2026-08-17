import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";
import {
  findChildSpans,
  findLatestSpan,
  spanInstrumentationName,
} from "../../helpers/trace-selectors";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunOpenAIScenario = (harness: {
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

type RelevantEvent = {
  event: CapturedLogEvent;
  summaryName?: string;
};

type OperationSpec = {
  childNames: readonly string[];
  nestedChildNames?: readonly string[];
  expectsOutput: boolean;
  expectsModel?: boolean;
  expectsTimeToFirstToken: boolean;
  minOpenAIMajorVersion?: number;
  name: string;
  operation: string;
  requiresResponsesCompact?: boolean;
  testName: string;
  validate?: (span: CapturedLogEvent | undefined) => void;
};

const EXPECTED_BATCH_OUTPUTS = new Map<string, string | undefined>([
  ["Reply with exactly ALPHA.", "ALPHA"],
  ["Reply with exactly BRAVO.", "BRAVO"],
  ["Reply with exactly CHARLIE.", undefined],
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateStreamFixtureOutput(span: CapturedLogEvent | undefined): void {
  const firstChoice = Array.isArray(span?.output) ? span?.output[0] : undefined;
  const choice = asRecord(firstChoice);
  const message = asRecord(choice?.message);

  expect(choice?.logprobs).toEqual(
    expect.objectContaining({
      content: expect.arrayContaining([
        expect.objectContaining({ token: "NO" }),
        expect.objectContaining({ token: "PE" }),
      ]),
    }),
  );
  expect(message?.refusal).toBe("NOPE");
}

function validateAttachmentInput(
  span: CapturedLogEvent | undefined,
  contentType: string,
): void {
  const serialized = JSON.stringify(span?.input);

  expect(serialized).toContain("braintrust_attachment");
  expect(serialized).toContain(contentType);
}

function validateToolOutput(span: CapturedLogEvent | undefined): void {
  const choices = Array.isArray(span?.output) ? span.output : [];
  const toolCalls = choices.flatMap((choice) => {
    const message = asRecord(asRecord(choice)?.message);
    const calls = message?.tool_calls;
    return Array.isArray(calls) ? calls : [];
  });

  expect(toolCalls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        function: expect.objectContaining({
          name: "get_weather",
        }),
      }),
    ]),
  );
}

const OPERATION_SPECS: readonly OperationSpec[] = [
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-chat-operation",
    operation: "chat",
    testName: "captures trace for client.chat.completions.create()",
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-chat-with-response-operation",
    operation: "chat-with-response",
    testName: "captures trace for chat completion with response metadata",
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    minOpenAIMajorVersion: 6,
    name: "openai-chat-image-attachment-operation",
    operation: "chat-image-attachment",
    testName: "captures trace for chat completion image attachments",
    validate: (span) => validateAttachmentInput(span, "image/png"),
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    minOpenAIMajorVersion: 6,
    name: "openai-chat-pdf-attachment-operation",
    operation: "chat-pdf-attachment",
    testName: "captures trace for chat completion PDF attachments",
    validate: (span) => validateAttachmentInput(span, "application/pdf"),
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-chat-tool-operation",
    operation: "chat-tool",
    testName: "captures trace for chat completion tool calls",
    validate: validateToolOutput,
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: true,
    name: "openai-stream-operation",
    operation: "stream",
    testName:
      "captures trace for client.chat.completions.create({ stream: true })",
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: true,
    name: "openai-stream-with-response-operation",
    operation: "stream-with-response",
    testName:
      "captures trace for streamed chat completion with response metadata",
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: true,
    name: "openai-stream-tool-operation",
    operation: "stream-tool",
    testName: "captures trace for streamed chat completion tool calls",
    validate: validateToolOutput,
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: true,
    name: "openai-stream-fixture-operation",
    operation: "stream-fixture",
    testName:
      "captures trace for streamed chat completion with logprobs and refusal",
    validate: validateStreamFixtureOutput,
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-parse-operation",
    operation: "parse",
    testName: "captures trace for chat completion parsing",
    validate: (span) => {
      expect(JSON.stringify(span?.output)).toContain("answer");
    },
  },
  {
    childNames: ["Chat Completion"],
    expectsOutput: true,
    expectsTimeToFirstToken: true,
    name: "openai-sync-stream-operation",
    operation: "sync-stream",
    testName: "captures trace for client.chat.completions.stream()",
  },
  {
    childNames: ["Embedding"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-embeddings-operation",
    operation: "embeddings",
    testName: "captures trace for client.embeddings.create()",
    validate: (span) => {
      expect(
        typeof (span?.output as { embedding_length?: unknown } | undefined)
          ?.embedding_length,
      ).toBe("number");
    },
  },
  {
    childNames: ["Moderation"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-moderations-operation",
    operation: "moderations",
    testName: "captures trace for client.moderations.create()",
    validate: (span) => {
      expect(Array.isArray(span?.output)).toBe(true);
    },
  },
  {
    childNames: ["openai.batch"],
    nestedChildNames: ["Chat Completion"],
    expectsModel: false,
    expectsOutput: false,
    expectsTimeToFirstToken: false,
    name: "openai-batch-operation",
    operation: "batch",
    testName: "captures resumable OpenAI Batch task and LLM spans",
    validate: (span) => {
      expect(span?.input).toBeUndefined();
      expect(span?.output).toBeUndefined();
    },
  },
  {
    childNames: ["openai.responses.create"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-responses-operation",
    operation: "responses",
    testName: "captures trace for client.responses.create()",
  },
  {
    childNames: ["openai.responses.create"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-responses-with-response-operation",
    operation: "responses-with-response",
    testName: "captures trace for client.responses.create().withResponse()",
  },
  {
    childNames: ["openai.responses.create"],
    expectsOutput: true,
    expectsTimeToFirstToken: true,
    name: "openai-responses-create-stream-operation",
    operation: "responses-create-stream",
    testName: "captures trace for client.responses.create({ stream: true })",
  },
  {
    childNames: ["openai.responses.create"],
    expectsOutput: true,
    expectsTimeToFirstToken: true,
    name: "openai-responses-stream-operation",
    operation: "responses-stream",
    testName: "captures trace for client.responses.stream()",
  },
  {
    childNames: ["openai.responses.create"],
    expectsOutput: false,
    expectsTimeToFirstToken: true,
    name: "openai-responses-stream-partial-operation",
    operation: "responses-stream-partial",
    testName: "captures partial streamed responses before final output",
  },
  {
    childNames: ["openai.responses.parse", "openai.responses.create"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-responses-parse-operation",
    operation: "responses-parse",
    testName: "captures trace for client.responses.parse()",
    validate: (span) => {
      const output = JSON.stringify(span?.output);
      expect(output).toContain("reasoning");
      expect(output).toContain("value");
    },
  },
  {
    childNames: ["openai.responses.compact"],
    expectsOutput: true,
    expectsTimeToFirstToken: false,
    name: "openai-responses-compact-operation",
    operation: "responses-compact",
    requiresResponsesCompact: true,
    testName: "captures trace for client.responses.compact()",
  },
] as const;

function supportsResponsesCompact(version: string): boolean {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number.parseInt(majorRaw ?? "", 10);
  const minor = Number.parseInt(minorRaw ?? "", 10);

  return (
    Number.isFinite(major) &&
    Number.isFinite(minor) &&
    (major > 6 || (major === 6 && minor >= 10))
  );
}

function getOperationSpecs(version: string): OperationSpec[] {
  const compactSupported = supportsResponsesCompact(version);
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return OPERATION_SPECS.filter(
    (spec) =>
      (!spec.requiresResponsesCompact || compactSupported) &&
      (!spec.minOpenAIMajorVersion ||
        (Number.isFinite(major) && major >= spec.minOpenAIMajorVersion)),
  );
}

function findOpenAISpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: readonly string[],
) {
  for (const name of names) {
    const spans = findChildSpans(events, name, parentId);
    if (spans.length > 0) {
      return spans.find((span) => span.output !== undefined) ?? spans.at(-1);
    }
  }

  return undefined;
}

function findOpenAISpans(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: readonly string[],
) {
  for (const name of names) {
    const spans = findChildSpans(events, name, parentId);
    if (spans.length > 0) {
      return spans;
    }
  }

  return [];
}

function batchPrompt(span: CapturedLogEvent): string {
  const firstMessage = Array.isArray(span.input) ? span.input[0] : undefined;
  const content = asRecord(firstMessage)?.content;
  return typeof content === "string" ? content : "";
}

function buildRelevantEvents(
  events: CapturedLogEvent[],
  operationSpecs: OperationSpec[],
) {
  const relevantEvents: RelevantEvent[] = [
    { event: findLatestSpan(events, ROOT_NAME)! },
  ];

  for (const spec of operationSpecs) {
    const operation = findLatestSpan(events, spec.name)!;
    relevantEvents.push({ event: operation });
    const providerSpan = findOpenAISpan(
      events,
      operation.span.id,
      spec.childNames,
    )!;
    relevantEvents.push({
      event: providerSpan,
      summaryName: spec.childNames[0],
    });
    if (spec.nestedChildNames) {
      relevantEvents.push(
        ...findOpenAISpans(events, providerSpan.span.id, spec.nestedChildNames)
          .sort((left, right) =>
            batchPrompt(left).localeCompare(batchPrompt(right)),
          )
          .map((event) => ({
            event,
            summaryName: spec.nestedChildNames?.[0],
          })),
      );
    }
  }

  return relevantEvents;
}

function buildSpanTree(
  events: CapturedLogEvent[],
  operationSpecs: OperationSpec[],
): SpanTreeEntry[] {
  return buildRelevantEvents(events, operationSpecs).map(
    ({ event, summaryName }) => {
      return {
        event,
        fields: {
          ...spanTreeFields(event),
          context: event.context,
        },
        name: summaryName ?? event.span.name,
      };
    },
  );
}

export function defineOpenAIInstrumentationAssertions(options: {
  assertPrivateFieldMethodsOperation?: boolean;
  cassetteName?: string;
  name: string;
  runScenario: RunOpenAIScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
  version: string;
}): void {
  const operationSpecs = getOperationSpecs(options.version);
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

    test("captures the root trace for the scenario", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        openaiSdkVersion: options.version,
        scenario: SCENARIO_NAME,
      });
    });

    if (options.assertPrivateFieldMethodsOperation) {
      test(
        "keeps wrapped v6 client private-field methods callable",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const operation = findLatestSpan(
            events,
            "openai-client-private-fields-operation",
          );

          expect(operation).toBeDefined();
          expect(operation?.row.metadata).toMatchObject({
            operation: "client-private-fields",
          });
          expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        },
      );
    }

    test("records OpenAI span provenance", testConfig, () => {
      for (const spec of operationSpecs) {
        const operation = findLatestSpan(events, spec.name);
        const span = findOpenAISpan(
          events,
          operation?.span.id,
          spec.childNames,
        );
        expect(spanInstrumentationName(span)).toBe("openai");
        if (spec.nestedChildNames) {
          const nested = findOpenAISpans(
            events,
            span?.span.id,
            spec.nestedChildNames,
          );
          expect(nested).toHaveLength(EXPECTED_BATCH_OUTPUTS.size);
          for (const child of nested) {
            expect(spanInstrumentationName(child)).toBe("openai");
          }
        }
      }
    });

    const scenarioDir = path.dirname(fileURLToPath(options.testFileUrl));
    const cassetteMode = process.env.BRAINTRUST_E2E_CASSETTE_MODE;
    const cassetteEngaged =
      cassetteMode === "record" ||
      cassetteMode === "record-missing" ||
      cassetteMode === "replay" ||
      existsSync(
        path.join(
          scenarioDir,
          "__cassettes__",
          `${options.cassetteName ?? options.snapshotName}.cassette.json`,
        ),
      );

    for (const spec of operationSpecs) {
      test(spec.testName, testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(events, spec.name);
        const span = findOpenAISpan(
          events,
          operation?.span.id,
          spec.childNames,
        );

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.row.metadata).toMatchObject({
          operation: spec.operation,
        });
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          provider: "openai",
        });
        if (spec.expectsModel !== false) {
          expect(
            typeof (span?.row.metadata as { model?: unknown } | undefined)
              ?.model,
          ).toBe("string");
        }

        if (spec.expectsOutput) {
          expect(span?.output).toBeDefined();
        } else if (!cassetteEngaged) {
          // Under cassette replay, partial-stream tests can't reliably
          // produce undefined output: the recorded SSE chunks deliver
          // faster than the consumer can `break` out of the iteration.
          // Only enforce the strict expectation against the live API.
          expect(span?.output).toBeUndefined();
        }

        if (spec.expectsTimeToFirstToken) {
          expect(span?.metrics?.time_to_first_token).toEqual(
            expect.any(Number),
          );
        }

        if (spec.nestedChildNames) {
          const nested = findOpenAISpans(
            events,
            span?.span.id,
            spec.nestedChildNames,
          );
          expect(nested).toHaveLength(EXPECTED_BATCH_OUTPUTS.size);
          expect(span?.span.parentIds).toEqual([operation?.span.id ?? ""]);
          expect(nested.map(batchPrompt).sort()).toEqual(
            [...EXPECTED_BATCH_OUTPUTS.keys()].sort(),
          );
          for (const child of nested) {
            const prompt = batchPrompt(child);
            const firstChoice = Array.isArray(child.output)
              ? asRecord(child.output[0])
              : undefined;
            const message = asRecord(firstChoice?.message);

            expect(child.span.parentIds).toEqual([span?.span.id ?? ""]);
            expect(child.row.metadata).toMatchObject({
              model: expect.any(String),
              provider: "openai",
            });
            const expectedOutput = EXPECTED_BATCH_OUTPUTS.get(prompt);
            if (expectedOutput) {
              expect(message?.content).toBe(expectedOutput);
              expect(child.row.error).toBeUndefined();
            } else {
              expect(child.output).toBeUndefined();
              expect(child.row.error).toContain("Batch fixture request failed");
            }
            expect(child.metrics?.time_to_first_token).toBeUndefined();
          }
        }

        spec.validate?.(span);
      });
    }

    test("matches the shared span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(
        buildSpanTree(events, operationSpecs),
        spanSnapshotPath,
        {
          normalize: { omittedKeys: ["prompt_cache_key"] },
        },
      );
    });
  });
}
