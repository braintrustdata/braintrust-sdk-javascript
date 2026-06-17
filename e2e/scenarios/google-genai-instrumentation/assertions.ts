import { beforeAll, describe, expect, test } from "vitest";
import type { Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
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
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";

import {
  GOOGLE_EMBEDDING_MODEL,
  GOOGLE_INTERACTIONS_MODEL,
  GOOGLE_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./scenario.impl.mjs";

type RunGoogleGenAIScenario = (harness: {
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

function findGoogleSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  for (const name of names) {
    const span =
      findLatestChildSpan(events, name, parentId) ??
      findChildSpans(events, name, parentId)[0];
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

function extractGroundingMetadataFromOutput(
  output: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!output) {
    return undefined;
  }

  if (isRecord(output.groundingMetadata as Json)) {
    return output.groundingMetadata as Record<string, unknown>;
  }

  const candidates = output.candidates;
  if (!Array.isArray(candidates)) {
    return undefined;
  }

  for (const candidate of candidates) {
    if (!isRecord(candidate as Json)) {
      continue;
    }

    if (isRecord(candidate.groundingMetadata as Json)) {
      return candidate.groundingMetadata as Record<string, unknown>;
    }
  }

  return undefined;
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
        "total_output_tokens",
        "totalTokenCount",
        "total_tokens",
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
      [
        "prompt_tokens",
        "prompt_cached_tokens",
        "promptTokenCount",
        "tokenCount",
        "total_cached_tokens",
        "total_input_tokens",
      ].includes(key)
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
    delete usageMetadata.serviceTier;

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
  const systemInstructionOperation = findLatestSpan(
    events,
    "google-system-instruction-operation",
  );
  const multiTurnOperation = findLatestSpan(
    events,
    "google-multi-turn-operation",
  );
  const embedOperation = findLatestSpan(events, "google-embed-operation");
  const interactionOperation = findLatestSpan(
    events,
    "google-interaction-operation",
  );
  const interactionStreamOperation = findLatestSpan(
    events,
    "google-interaction-stream-operation",
  );
  const interactionStatefulFirstOperation = findLatestSpan(
    events,
    "google-interaction-stateful-first-operation",
  );
  const interactionStatefulSecondOperation = findLatestSpan(
    events,
    "google-interaction-stateful-second-operation",
  );
  const interactionBackgroundOperation = findLatestSpan(
    events,
    "google-interaction-background-operation",
  );
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
  const multiToolOperation = findLatestSpan(
    events,
    "google-multi-tool-operation",
  );

  return [
    findLatestSpan(events, ROOT_NAME),
    generateOperation,
    findGoogleSpan(events, generateOperation?.span.id, [
      "generate_content",
      "google-genai.generateContent",
    ]),
    systemInstructionOperation,
    findGoogleSpan(events, systemInstructionOperation?.span.id, [
      "generate_content",
      "google-genai.generateContent",
    ]),
    multiTurnOperation,
    findGoogleSpan(events, multiTurnOperation?.span.id, [
      "generate_content",
      "google-genai.generateContent",
    ]),
    embedOperation,
    findGoogleSpan(events, embedOperation?.span.id, [
      "embed_content",
      "google-genai.embedContent",
    ]),
    interactionOperation,
    findGoogleSpan(events, interactionOperation?.span.id, [
      "create_interaction",
      "google-genai.interactionsCreate",
    ]),
    interactionStreamOperation,
    findGoogleSpan(events, interactionStreamOperation?.span.id, [
      "create_interaction",
      "google-genai.interactionsCreate",
    ]),
    interactionStatefulFirstOperation,
    findGoogleSpan(events, interactionStatefulFirstOperation?.span.id, [
      "create_interaction",
      "google-genai.interactionsCreate",
    ]),
    interactionStatefulSecondOperation,
    findGoogleSpan(events, interactionStatefulSecondOperation?.span.id, [
      "create_interaction",
      "google-genai.interactionsCreate",
    ]),
    interactionBackgroundOperation,
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
    multiToolOperation,
    findGoogleSpan(events, multiToolOperation?.span.id, [
      "generate_content",
      "google-genai.generateContent",
    ]),
  ].filter((event): event is CapturedLogEvent => event !== undefined);
}

function buildSpanTree(events: CapturedLogEvent[]): SpanTreeEntry[] {
  return buildRelevantEvents(events).map((event) => {
    const summary = summarizeGooglePayload(event) as Record<string, Json>;
    const { name: _name, type: _type, ...fields } = summary;

    return {
      event,
      fields: {
        span_attributes: spanTreeFields(event).span_attributes,
        ...fields,
      },
      name: typeof summary.name === "string" ? summary.name : event.span.name,
    };
  });
}

function outputHasFunctionCall(
  output:
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
    | undefined,
  name: string,
): boolean {
  return (
    output?.functionCalls?.some((call) => call.name === name) ||
    output?.candidates?.some((candidate) =>
      candidate.content?.parts?.some(
        (part) => part.functionCall?.name === name,
      ),
    ) ||
    false
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
    `${options.snapshotName}.span-tree.json`,
  );
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const testConfig = {
    timeout: timeoutMs,
  };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, timeoutMs);

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
          model: GOOGLE_MODEL,
        });
      },
    );

    test("captures system instruction metadata and input", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "google-system-instruction-operation",
      );
      const span = findGoogleSpan(events, operation?.span.id, [
        "generate_content",
        "google-genai.generateContent",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        model: GOOGLE_MODEL,
        systemInstruction: "You are a pirate. Always respond in pirate speak.",
      });
      expect(span?.input).toMatchObject({
        config: expect.objectContaining({
          systemInstruction:
            "You are a pirate. Always respond in pirate speak.",
        }),
      });
    });

    test("captures multi-turn conversation input", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "google-multi-turn-operation");
      const span = findGoogleSpan(events, operation?.span.id, [
        "generate_content",
        "google-genai.generateContent",
      ]);
      const input = span?.input as { contents?: unknown[] } | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(input?.contents).toHaveLength(3);
      expect(span?.metrics).toMatchObject({
        prompt_tokens: expect.any(Number),
      });
    });

    test("captures trace for client.models.embedContent()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "google-embed-operation");
      const span = findGoogleSpan(events, operation?.span.id, [
        "embed_content",
        "google-genai.embedContent",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        model: GOOGLE_EMBEDDING_MODEL,
      });
      expect(span?.output).toMatchObject({
        embedding_count: expect.any(Number),
        embedding_length: expect.any(Number),
      });
      expect(span?.metrics).toMatchObject({
        duration: expect.any(Number),
        end: expect.any(Number),
        start: expect.any(Number),
      });
    });

    test("captures trace for client.interactions.create()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "google-interaction-operation");
      if (!operation) {
        return;
      }

      const span = findGoogleSpan(events, operation.span.id, [
        "create_interaction",
        "google-genai.interactionsCreate",
      ]);

      expect(span).toBeDefined();
      expect(operation.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        model: GOOGLE_INTERACTIONS_MODEL,
      });
      expect(span?.input).toMatchObject({
        generation_config: expect.objectContaining({
          max_output_tokens: 256,
          thinking_level: "minimal",
          temperature: 0,
        }),
        input: {
          text: "Reply with exactly ROME.",
          type: "text",
        },
        model: GOOGLE_INTERACTIONS_MODEL,
      });
      expect(span?.output).toMatchObject({
        output_text: expect.any(String),
        status: "completed",
      });
      expect(span?.metrics).toMatchObject({
        prompt_tokens: expect.any(Number),
        tokens: expect.any(Number),
      });
    });

    test(
      "captures trace for streaming client.interactions.create()",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "google-interaction-stream-operation",
        );
        if (!operation) {
          return;
        }

        const span = findGoogleSpan(events, operation.span.id, [
          "create_interaction",
          "google-genai.interactionsCreate",
        ]);

        expect(span).toBeDefined();
        expect(operation.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          model: GOOGLE_INTERACTIONS_MODEL,
        });
        expect(span?.input).toMatchObject({
          generation_config: expect.objectContaining({
            max_output_tokens: 256,
            thinking_level: "minimal",
            temperature: 0,
          }),
          input: {
            text: "Count from 1 to 3 and include the words one two three.",
            type: "text",
          },
          model: GOOGLE_INTERACTIONS_MODEL,
          stream: true,
        });
        expect(span?.output).toMatchObject({
          output_text: expect.any(String),
          status: "completed",
        });
        expect(span?.metrics).toMatchObject({
          prompt_tokens: expect.any(Number),
          time_to_first_token: expect.any(Number),
          tokens: expect.any(Number),
        });
      },
    );

    test(
      "captures stateful client.interactions.create() conversation",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const firstOperation = findLatestSpan(
          events,
          "google-interaction-stateful-first-operation",
        );
        const secondOperation = findLatestSpan(
          events,
          "google-interaction-stateful-second-operation",
        );
        if (!firstOperation || !secondOperation) {
          return;
        }

        const firstSpan = findGoogleSpan(events, firstOperation.span.id, [
          "create_interaction",
          "google-genai.interactionsCreate",
        ]);
        const secondSpan = findGoogleSpan(events, secondOperation.span.id, [
          "create_interaction",
          "google-genai.interactionsCreate",
        ]);
        const firstOutput = firstSpan?.output as
          | { id?: string; status?: string }
          | undefined;

        expect(firstSpan).toBeDefined();
        expect(secondSpan).toBeDefined();
        expect(firstOperation.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(secondOperation.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(firstOutput?.id).toEqual(expect.any(String));
        expect(firstSpan?.output).toMatchObject({
          status: "completed",
        });
        expect(secondSpan?.input).toMatchObject({
          generation_config: expect.objectContaining({
            max_output_tokens: 256,
            thinking_level: "minimal",
            temperature: 0,
          }),
          input: {
            text: "What is my name? Reply with exactly AMIR.",
            type: "text",
          },
          model: GOOGLE_INTERACTIONS_MODEL,
          previous_interaction_id: firstOutput?.id,
        });
        expect(secondSpan?.output).toMatchObject({
          output_text: expect.any(String),
          status: "completed",
        });
      },
    );

    test(
      "does not trace background client.interactions.create() tasks",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "google-interaction-background-operation",
        );
        if (!operation) {
          return;
        }

        const span = findGoogleSpan(events, operation.span.id, [
          "create_interaction",
          "google-genai.interactionsCreate",
        ]);

        expect(operation.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span).toBeUndefined();
      },
    );

    // TODO(lforst): Gotta figure out why google rejects a normal ai studio api key for this call
    // test("captures trace for chat.sendMessage()", testConfig, () => {
    //   const root = findLatestSpan(events, ROOT_NAME);
    //   const operation = findLatestSpan(events, "google-chat-operation");
    //   const span = findGoogleSpan(events, operation?.span.id, [
    //     "generate_content",
    //     "google-genai.generateContent",
    //   ]);

    //   expect(operation).toBeDefined();
    //   expect(span).toBeDefined();
    //   expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
    //   expect(span?.row.metadata).toMatchObject({
    //     model: GOOGLE_MODEL,
    //   });
    //   expect(span?.metrics).toMatchObject({
    //     duration: expect.any(Number),
    //     end: expect.any(Number),
    //     start: expect.any(Number),
    //   });
    // });

    // TODO(lforst): Gotta figure out why google rejects a normal ai studio api key for this call
    // test("captures trace for chat.sendMessageStream()", testConfig, () => {
    //   const root = findLatestSpan(events, ROOT_NAME);
    //   const operation = findLatestSpan(events, "google-chat-stream-operation");
    //   const span = findGoogleSpan(events, operation?.span.id, [
    //     "generate_content_stream",
    //     "google-genai.generateContentStream",
    //   ]);

    //   expect(operation).toBeDefined();
    //   expect(span).toBeDefined();
    //   expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
    //   expect(span?.row.metadata).toMatchObject({
    //     model: GOOGLE_MODEL,
    //   });
    //   expect(span?.metrics).toMatchObject({
    //     time_to_first_token: expect.any(Number),
    //     prompt_tokens: expect.any(Number),
    //     completion_tokens: expect.any(Number),
    //   });
    // });

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
        model: GOOGLE_MODEL,
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
          model: GOOGLE_MODEL,
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
          model: GOOGLE_MODEL,
        });
        expect(span?.metrics).toMatchObject({
          time_to_first_token: expect.any(Number),
          prompt_tokens: expect.any(Number),
        });
      },
    );

    test("captures grounding metadata for generateContent", testConfig, () => {
      const operation = findLatestSpan(
        events,
        "google-grounded-generate-operation",
      );
      const span = findGoogleSpan(events, operation?.span.id, [
        "generate_content",
        "google-genai.generateContent",
      ]);
      const metadata = span?.row.metadata as
        | Record<string, unknown>
        | undefined;
      const output = span?.output as Record<string, unknown> | undefined;
      const metadataGrounding = metadata?.groundingMetadata as
        | Record<string, unknown>
        | undefined;
      const outputGrounding = extractGroundingMetadataFromOutput(output);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(metadataGrounding).toBeDefined();
      expect(outputGrounding).toBeDefined();
      expect(Array.isArray(metadataGrounding?.webSearchQueries)).toBe(true);
      expect(Array.isArray(outputGrounding?.webSearchQueries)).toBe(true);
    });

    test(
      "captures grounding metadata for generateContentStream",
      testConfig,
      () => {
        const operation = findLatestSpan(
          events,
          "google-grounded-stream-operation",
        );
        const span = findGoogleSpan(events, operation?.span.id, [
          "generate_content_stream",
          "google-genai.generateContentStream",
        ]);
        const metadata = span?.row.metadata as
          | Record<string, unknown>
          | undefined;
        const output = span?.output as Record<string, unknown> | undefined;
        const metadataGrounding = metadata?.groundingMetadata as
          | Record<string, unknown>
          | undefined;
        const outputGrounding = extractGroundingMetadataFromOutput(output);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(metadataGrounding).toBeDefined();
        expect(outputGrounding).toBeDefined();
        expect(Array.isArray(metadataGrounding?.webSearchQueries)).toBe(true);
        expect(Array.isArray(outputGrounding?.webSearchQueries)).toBe(true);
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
        model: GOOGLE_MODEL,
      });
      expect(outputHasFunctionCall(output, "get_weather")).toBe(true);
    });

    test("captures trace for multi-tool calling", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "google-multi-tool-operation");
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
        model: GOOGLE_MODEL,
      });
      expect(JSON.stringify(span?.row.metadata)).toContain("get_weather");
      expect(JSON.stringify(span?.row.metadata)).toContain("get_time");
      expect(outputHasFunctionCall(output, "get_weather")).toBe(true);
    });

    test("matches the shared span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath);
    });
  });
}
