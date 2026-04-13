import { beforeAll, describe, expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunOpenAIScenario = (harness: {
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

type RelevantEvent = {
  event: CapturedLogEvent;
  summaryName?: string;
};

type OperationSpec = {
  childNames: readonly string[];
  expectsOutput: boolean;
  expectsTimeToFirstToken: boolean;
  name: string;
  operation: string;
  requiresResponsesCompact?: boolean;
  testName: string;
  validate?: (span: CapturedLogEvent | undefined) => void;
};

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
  return OPERATION_SPECS.filter(
    (spec) => !spec.requiresResponsesCompact || compactSupported,
  );
}

function pickMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): Json {
  if (!metadata) {
    return null;
  }

  const picked = Object.fromEntries(
    keys.flatMap((key) => {
      const value = metadata[key];
      if (value === undefined) {
        return [];
      }

      return [
        [
          key,
          key === "openaiSdkVersion" && typeof value === "string"
            ? "<openai-sdk-version>"
            : (value as Json),
        ],
      ];
    }),
  );

  return Object.keys(picked).length > 0 ? (picked as Json) : null;
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeMetricPresence(metrics: Json): Json {
  if (!isRecord(metrics)) {
    return null;
  }

  return {
    has_time_to_first_token: typeof metrics.time_to_first_token === "number",
  } satisfies Json;
}

function jsonKeysFromText(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return [];
    }

    return Object.keys(parsed).sort();
  } catch {
    return [];
  }
}

function summarizeInput(input: Json): Json {
  if (typeof input === "string") {
    return {
      kind: "text",
    } satisfies Json;
  }

  if (!Array.isArray(input)) {
    return input === null ? null : ({ kind: typeof input } satisfies Json);
  }

  return input.map((message) => {
    if (!isRecord(message as Json)) {
      return { kind: typeof message } satisfies Json;
    }

    return {
      content_kind: Array.isArray(message.content)
        ? "blocks"
        : typeof message.content,
      role: message.role ?? null,
    } satisfies Json;
  }) satisfies Json;
}

function summarizeChatOutput(output: Json): Json {
  if (!Array.isArray(output)) {
    return null;
  }

  return output.map((choice) => {
    if (!isRecord(choice as Json) || !isRecord(choice.message as Json)) {
      return null;
    }

    return {
      json_keys: jsonKeysFromText(choice.message.content),
      role: choice.message.role ?? null,
    } satisfies Json;
  }) satisfies Json;
}

function summarizeResponsesOutput(
  output: Json,
  options?: {
    dropEmptyOutputTextMessages?: boolean;
  },
): Json {
  if (!Array.isArray(output)) {
    return null;
  }

  const summaries = output.map((item) => {
    if (!isRecord(item as Json)) {
      return null;
    }

    const content = Array.isArray(item.content) ? item.content : [];
    const contentTypes = content.flatMap((entry) =>
      isRecord(entry as Json) && typeof entry.type === "string"
        ? [entry.type]
        : [],
    );
    const jsonKeys = content.flatMap((entry) =>
      isRecord(entry as Json) ? jsonKeysFromText(entry.text) : [],
    );

    return {
      content_types: contentTypes,
      json_keys: [...new Set(jsonKeys)].sort(),
      role: item.role ?? null,
      status: item.status ?? null,
      type: item.type ?? null,
    } satisfies Json;
  });

  const filtered = options?.dropEmptyOutputTextMessages
    ? summaries.filter((item) => {
        if (!isRecord(item as Json)) {
          return true;
        }

        return !(
          item.role === "assistant" &&
          item.status === "completed" &&
          item.type === "message" &&
          Array.isArray(item.content_types) &&
          item.content_types.length === 1 &&
          item.content_types[0] === "output_text" &&
          Array.isArray(item.json_keys) &&
          item.json_keys.length === 0
        );
      })
    : summaries;

  // Deduplicate identical items — the Responses API occasionally returns
  // duplicate output entries (e.g., two identical "message" items when
  // streaming), which would cause non-deterministic snapshot failures.
  const seen = new Set<string>();
  const deduped: Json[] = [];

  for (const summarized of filtered) {
    const key = JSON.stringify(summarized);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(summarized);
    }
  }

  return deduped;
}

function summarizeOutput(name: string, output: Json): Json {
  if (name === "Chat Completion") {
    return summarizeChatOutput(output);
  }

  if (name === "Embedding") {
    return isRecord(output)
      ? ({
          embedding_length: output.embedding_length ?? null,
        } satisfies Json)
      : null;
  }

  if (name === "Moderation") {
    return Array.isArray(output)
      ? ({
          flagged_count: output.filter(
            (entry) => isRecord(entry as Json) && entry.flagged === true,
          ).length,
          result_count: output.length,
        } satisfies Json)
      : null;
  }

  if (
    name === "openai.responses.create" ||
    name === "openai.responses.compact"
  ) {
    return summarizeResponsesOutput(output);
  }

  if (name === "openai.responses.parse") {
    return summarizeResponsesOutput(output, {
      dropEmptyOutputTextMessages: true,
    });
  }

  return output === null || output === undefined
    ? null
    : ({ kind: typeof output } satisfies Json);
}

function summarizeOpenAISpan(
  event: CapturedLogEvent,
  summaryName: string | undefined,
): Json {
  return {
    has_input: event.input !== undefined && event.input !== null,
    has_output: event.output !== undefined && event.output !== null,
    metadata: pickMetadata(
      event.row.metadata as Record<string, unknown> | undefined,
      ["model", "openaiSdkVersion", "operation", "provider", "scenario"],
    ),
    metrics: summarizeMetricPresence(event.metrics as Json),
    name: summaryName ?? event.span.name ?? null,
    type: event.span.type ?? null,
  } satisfies Json;
}

function summarizeOpenAIPayload(
  event: CapturedLogEvent,
  summaryName: string | undefined,
): Json {
  const name = summaryName ?? event.span.name ?? "";

  return {
    input: summarizeInput(event.input as Json),
    metadata: pickMetadata(
      event.row.metadata as Record<string, unknown> | undefined,
      ["model", "openaiSdkVersion", "operation", "provider", "scenario"],
    ),
    metrics: summarizeMetricPresence(event.metrics as Json),
    name: name || null,
    output: summarizeOutput(name, event.output as Json),
    type: event.span.type ?? null,
  } satisfies Json;
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
    relevantEvents.push({
      event: findOpenAISpan(events, operation.span.id, spec.childNames)!,
      summaryName: spec.childNames[0],
    });
  }

  return relevantEvents;
}

function buildSpanSummary(
  events: CapturedLogEvent[],
  operationSpecs: OperationSpec[],
): Json {
  return normalizeForSnapshot(
    buildRelevantEvents(events, operationSpecs).map(({ event, summaryName }) =>
      summarizeOpenAISpan(event, summaryName),
    ) as Json,
  );
}

function buildPayloadSummary(
  events: CapturedLogEvent[],
  operationSpecs: OperationSpec[],
): Json {
  return normalizeForSnapshot(
    buildRelevantEvents(events, operationSpecs).map(({ event, summaryName }) =>
      summarizeOpenAIPayload(event, summaryName),
    ) as Json,
  );
}

export function defineOpenAIInstrumentationAssertions(options: {
  assertPrivateFieldMethodsOperation?: boolean;
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
    `${options.snapshotName}.span-events.json`,
  );
  const payloadSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.log-payloads.json`,
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
        expect(
          typeof (span?.row.metadata as { model?: unknown } | undefined)?.model,
        ).toBe("string");

        if (spec.expectsOutput) {
          expect(span?.output).toBeDefined();
        } else {
          expect(span?.output).toBeUndefined();
        }

        if (spec.expectsTimeToFirstToken) {
          expect(span?.metrics?.time_to_first_token).toEqual(
            expect.any(Number),
          );
        }

        spec.validate?.(span);
      });
    }

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events, operationSpecs)),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });

    test("matches the shared payload snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildPayloadSummary(events, operationSpecs)),
      ).toMatchFileSnapshot(payloadSnapshotPath);
    });
  });
}
