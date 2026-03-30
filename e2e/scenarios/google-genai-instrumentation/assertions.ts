import { beforeAll, describe, expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunGoogleGenAIScenario = (harness: {
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

function findGoogleSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  for (const name of names) {
    const span = findChildSpans(events, name, parentId)[0];
    if (span) {
      return span;
    }
  }

  return undefined;
}

function pickMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): Json {
  if (!metadata) {
    return null;
  }

  const picked = Object.fromEntries(
    keys.flatMap((key) =>
      key in metadata ? [[key, metadata[key] as Json]] : [],
    ),
  );

  return Object.keys(picked).length > 0 ? (picked as Json) : null;
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGoogleVariableTokenCounts(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      normalizeGoogleVariableTokenCounts(entry as Json),
    );
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized = structuredClone(value);

  for (const [key, entry] of Object.entries(normalized)) {
    if (
      typeof entry === "number" &&
      [
        "candidatesTokenCount",
        "completion_tokens",
        "tokens",
        "totalTokenCount",
      ].includes(key)
    ) {
      normalized[key] = "<number>";
      continue;
    }

    normalized[key] = normalizeGoogleVariableTokenCounts(entry as Json);
  }

  return normalized;
}

function normalizeGooglePromptTokenCounts(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      normalizeGooglePromptTokenCounts(entry as Json),
    );
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized = structuredClone(value);

  for (const [key, entry] of Object.entries(normalized)) {
    if (
      typeof entry === "number" &&
      ["prompt_tokens", "promptTokenCount", "tokenCount"].includes(key)
    ) {
      normalized[key] = "<number>";
      continue;
    }

    normalized[key] = normalizeGooglePromptTokenCounts(entry as Json);
  }

  return normalized;
}

function normalizeGoogleMetrics(metrics: Json): Json {
  if (!isRecord(metrics)) {
    return metrics;
  }

  const normalized = structuredClone(metrics);
  delete normalized.prompt_cached_tokens;
  return normalizeGooglePromptTokenCounts(
    normalizeGoogleVariableTokenCounts(normalized),
  );
}

function normalizeGoogleOutput(event: CapturedLogEvent): Json {
  const output = event.output as Json;
  if (!isRecord(output)) {
    return output;
  }

  const normalized = structuredClone(output);
  const usageMetadata = normalized.usageMetadata;
  if (isRecord(usageMetadata)) {
    delete usageMetadata.cachedContentTokenCount;
    delete usageMetadata.cacheTokensDetails;

    const promptTokensDetails = usageMetadata.promptTokensDetails;
    if (Array.isArray(promptTokensDetails)) {
      promptTokensDetails.sort((left, right) =>
        String(
          isRecord(left as Json) ? (left.modality ?? "") : "",
        ).localeCompare(
          String(isRecord(right as Json) ? (right.modality ?? "") : ""),
        ),
      );
    }
  }

  const input = event.input as Json;
  const hasAttachmentInput =
    Array.isArray(input) &&
    input.some(
      (message) =>
        isRecord(message as Json) &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            isRecord(block as Json) &&
            isRecord(block.inlineData) &&
            block.inlineData.mimeType === "image/png",
        ),
    );

  if (!hasAttachmentInput) {
    return normalizeGooglePromptTokenCounts(
      normalizeGoogleVariableTokenCounts(normalized),
    );
  }

  const candidates = normalized.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (!isRecord(candidate as Json) || !isRecord(candidate.content)) {
        continue;
      }

      const parts = candidate.content.parts;
      if (!Array.isArray(parts)) {
        continue;
      }

      for (const part of parts) {
        if (isRecord(part as Json) && typeof part.text === "string") {
          part.text = "<google-attachment-description>";
        }
      }
    }
  }

  if (typeof normalized.text === "string") {
    normalized.text = "<google-attachment-description>";
  }

  return normalizeGooglePromptTokenCounts(
    normalizeGoogleVariableTokenCounts(normalized),
  );
}

function normalizeGoogleSummary(summary: Json): Json {
  if (!isRecord(summary) || !Array.isArray(summary.metric_keys)) {
    return summary;
  }

  return {
    ...summary,
    metric_keys: summary.metric_keys.filter(
      (metric): metric is string => metric !== "prompt_cached_tokens",
    ),
  } satisfies Json;
}

function summarizeGooglePayload(event: CapturedLogEvent): Json {
  return {
    input: event.input as Json,
    metadata: pickMetadata(
      event.row.metadata as Record<string, unknown> | undefined,
      ["model", "operation", "scenario"],
    ),
    metrics: normalizeGoogleMetrics(event.metrics as Json),
    name: event.span.name ?? null,
    output: normalizeGoogleOutput(event),
    type: event.span.type ?? null,
  } satisfies Json;
}

function buildRelevantEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const generateOperation = findLatestSpan(events, "google-generate-operation");
  const attachmentOperation = findLatestSpan(
    events,
    "google-attachment-operation",
  );
  const streamOperation = findLatestSpan(events, "google-stream-operation");
  const streamReturnOperation = findLatestSpan(
    events,
    "google-stream-return-operation",
  );
  const toolOperation = findLatestSpan(events, "google-tool-operation");

  return [
    findLatestSpan(events, ROOT_NAME),
    generateOperation,
    findGoogleSpan(events, generateOperation?.span.id, [
      "generate_content",
      "google-genai.generateContent",
    ]),
    attachmentOperation,
    findGoogleSpan(events, attachmentOperation?.span.id, [
      "generate_content",
      "google-genai.generateContent",
    ]),
    streamOperation,
    findGoogleSpan(events, streamOperation?.span.id, [
      "generate_content_stream",
      "google-genai.generateContentStream",
    ]),
    streamReturnOperation,
    findGoogleSpan(events, streamReturnOperation?.span.id, [
      "generate_content_stream",
      "google-genai.generateContentStream",
    ]),
    toolOperation,
    findGoogleSpan(events, toolOperation?.span.id, [
      "generate_content",
      "google-genai.generateContent",
    ]),
  ].map((event) => event!);
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
  return normalizeForSnapshot(
    buildRelevantEvents(events).map((event) =>
      normalizeGoogleSummary(
        summarizeWrapperContract(event, ["model", "operation", "scenario"]),
      ),
    ) as Json,
  );
}

function buildPayloadSummary(events: CapturedLogEvent[]): Json {
  return normalizeForSnapshot(
    buildRelevantEvents(events).map((event) =>
      summarizeGooglePayload(event),
    ) as Json,
  );
}

export function defineGoogleGenAIInstrumentationAssertions(options: {
  name: string;
  runScenario: RunGoogleGenAIScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
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
        scenario: SCENARIO_NAME,
      });
    });

    test(
      "captures trace for client.models.generateContent()",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(events, "google-generate-operation");
        const span = findGoogleSpan(events, operation?.span.id, [
          "generate_content",
          "google-genai.generateContent",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          model: "gemini-2.5-flash-lite",
        });
      },
    );

    test("captures trace for sending an attachment", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "google-attachment-operation");
      const span = findGoogleSpan(events, operation?.span.id, [
        "generate_content",
        "google-genai.generateContent",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        model: "gemini-2.5-flash-lite",
      });
      expect(JSON.stringify(span?.input)).toContain("file.png");
    });

    test(
      "captures trace for client.models.generateContentStream()",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(events, "google-stream-operation");
        const span = findGoogleSpan(events, operation?.span.id, [
          "generate_content_stream",
          "google-genai.generateContentStream",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          model: "gemini-2.5-flash-lite",
        });
        expect(span?.metrics).toMatchObject({
          time_to_first_token: expect.any(Number),
          prompt_tokens: expect.any(Number),
          completion_tokens: expect.any(Number),
        });
      },
    );

    test(
      "captures trace for the early-return streaming path",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "google-stream-return-operation",
        );
        const span = findGoogleSpan(events, operation?.span.id, [
          "generate_content_stream",
          "google-genai.generateContentStream",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          model: "gemini-2.5-flash-lite",
        });
        expect(span?.metrics).toMatchObject({
          time_to_first_token: expect.any(Number),
          prompt_tokens: expect.any(Number),
        });
      },
    );

    test("captures trace for tool calling", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "google-tool-operation");
      const span = findGoogleSpan(events, operation?.span.id, [
        "generate_content",
        "google-genai.generateContent",
      ]);
      const output = span?.output as
        | {
            candidates?: Array<{
              content?: {
                parts?: Array<{
                  functionCall?: { name?: string };
                }>;
              };
            }>;
            functionCalls?: Array<{ name?: string }>;
          }
        | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        model: "gemini-2.5-flash-lite",
      });
      expect(
        output?.functionCalls?.some((call) => call.name === "get_weather") ||
          output?.candidates?.some((candidate) =>
            candidate.content?.parts?.some(
              (part) => part.functionCall?.name === "get_weather",
            ),
          ),
      ).toBe(true);
    });

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events)),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });

    test("matches the shared payload snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildPayloadSummary(events)),
      ).toMatchFileSnapshot(payloadSnapshotPath);
    });
  });
}
