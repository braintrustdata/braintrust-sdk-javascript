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

type RunAnthropicScenario = (harness: {
  runNodeScenarioDir: (options: {
    nodeArgs: string[];
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function findAnthropicSpan(
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

function summarizeAnthropicPayload(event: CapturedLogEvent): Json {
  const summary = {
    input: event.input as Json,
    metadata: pickMetadata(
      event.row.metadata as Record<string, unknown> | undefined,
      [
        "provider",
        "model",
        "operation",
        "scenario",
        "stop_reason",
        "stop_sequence",
      ],
    ),
    metrics: event.metrics as Json,
    name: event.span.name ?? null,
    output: event.output as Json,
    type: event.span.type ?? null,
  } satisfies Json;

  // Normalize volatile fields in batch API responses.
  if (event.span.name?.startsWith("anthropic.messages.batches.")) {
    // Normalize batch ID input (used in retrieve/cancel/delete operations).
    if (
      typeof summary.input === "string" &&
      (summary.input as string).startsWith("msgbatch_")
    ) {
      summary.input = "<msgbatch_id>" as Json;
    }

    const output = structuredClone(
      summary.output as Record<string, Json> | null,
    );
    if (output && typeof output === "object" && !Array.isArray(output)) {
      if ("processing_status" in output) {
        output.processing_status = "<processing_status>";
      }
      if (
        "request_counts" in output &&
        typeof output.request_counts === "object" &&
        output.request_counts !== null
      ) {
        output.request_counts = Object.fromEntries(
          Object.keys(output.request_counts as Record<string, Json>).map(
            (k) => [k, 0],
          ),
        ) as Json;
      }
      if ("first_id" in output) {
        output.first_id = output.first_id ? "<msgbatch_id>" : null;
      }
      if ("last_id" in output) {
        output.last_id = output.last_id ? "<msgbatch_id>" : null;
      }
      if (Array.isArray((output as { data?: unknown }).data)) {
        output.data = "<batch-list-data>";
      }
      // Some SDK versions wrap list results in a `body` property.
      if (
        typeof (output as { body?: unknown }).body === "object" &&
        (output as { body?: unknown }).body !== null
      ) {
        output.body = "<batch-list-body>";
      }
      // Normalize timestamp fields that use +00:00 offset (not caught by the
      // default ISO_DATE_REGEX in normalize.ts which only matches Z suffix).
      for (const key of [
        "created_at",
        "expires_at",
        "ended_at",
        "cancel_initiated_at",
        "archived_at",
      ] as const) {
        if (key in output && typeof output[key] === "string") {
          output[key] = output[key] !== null ? "<timestamp>" : null;
        }
      }
    }
    summary.output = output as Json;
    return summary;
  }

  if (
    event.span.name !== "anthropic.messages.create" ||
    !Array.isArray((summary.output as { content?: unknown[] } | null)?.content)
  ) {
    return summary;
  }

  const output = structuredClone(
    summary.output as {
      content: Array<{ text?: string; type?: string }>;
    },
  );
  const textBlock = output.content.find(
    (block) => block.type === "text" && typeof block.text === "string",
  );
  const input = event.input as
    | Array<{
        content?:
          | string
          | Array<{
              source?: {
                data?: {
                  type?: string;
                };
              };
            }>;
      }>
    | undefined;
  const hasAttachmentInput = input?.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block) => block.source?.data?.type === "braintrust_attachment",
      ),
  );

  if (hasAttachmentInput && textBlock) {
    textBlock.text = "<anthropic-attachment-description>";
    summary.output = output as Json;
  }

  return summary;
}

function buildSpanSummary(
  events: CapturedLogEvent[],
  supportsBetaMessages: boolean,
  supportsBatches: boolean,
): Json {
  const createOperation = findLatestSpan(events, "anthropic-create-operation");
  const attachmentOperation = findLatestSpan(
    events,
    "anthropic-attachment-operation",
  );
  const streamOperation = findLatestSpan(events, "anthropic-stream-operation");
  const withResponseOperation = findLatestSpan(
    events,
    "anthropic-stream-with-response-operation",
  );
  const toolStreamOperation = findLatestSpan(
    events,
    "anthropic-stream-tool-operation",
  );
  const toolOperation = findLatestSpan(events, "anthropic-tool-operation");
  const batchesOperation = findLatestSpan(
    events,
    "anthropic-batches-operation",
  );
  const betaCreateOperation = findLatestSpan(
    events,
    "anthropic-beta-create-operation",
  );
  const betaStreamOperation = findLatestSpan(
    events,
    "anthropic-beta-stream-operation",
  );

  return normalizeForSnapshot(
    [
      findLatestSpan(events, ROOT_NAME),
      createOperation,
      findAnthropicSpan(events, createOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      attachmentOperation,
      findAnthropicSpan(events, attachmentOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      streamOperation,
      findAnthropicSpan(events, streamOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      withResponseOperation,
      findAnthropicSpan(events, withResponseOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      toolStreamOperation,
      findAnthropicSpan(events, toolStreamOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      toolOperation,
      findAnthropicSpan(events, toolOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      ...(supportsBatches
        ? [
            batchesOperation,
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.create",
            ]),
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.retrieve",
            ]),
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.list",
            ]),
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.cancel",
            ]),
          ]
        : []),
      ...(supportsBetaMessages
        ? [
            betaCreateOperation,
            findAnthropicSpan(events, betaCreateOperation?.span.id, [
              "anthropic.messages.create",
              "anthropic.beta.messages.create",
            ]),
            betaStreamOperation,
            findAnthropicSpan(events, betaStreamOperation?.span.id, [
              "anthropic.messages.create",
              "anthropic.beta.messages.create",
            ]),
          ]
        : []),
    ].map((event) =>
      summarizeWrapperContract(event!, [
        "provider",
        "model",
        "operation",
        "scenario",
      ]),
    ) as Json,
  );
}

function buildPayloadSummary(
  events: CapturedLogEvent[],
  supportsBetaMessages: boolean,
  supportsBatches: boolean,
): Json {
  const createOperation = findLatestSpan(events, "anthropic-create-operation");
  const attachmentOperation = findLatestSpan(
    events,
    "anthropic-attachment-operation",
  );
  const streamOperation = findLatestSpan(events, "anthropic-stream-operation");
  const withResponseOperation = findLatestSpan(
    events,
    "anthropic-stream-with-response-operation",
  );
  const toolStreamOperation = findLatestSpan(
    events,
    "anthropic-stream-tool-operation",
  );
  const toolOperation = findLatestSpan(events, "anthropic-tool-operation");
  const batchesOperation = findLatestSpan(
    events,
    "anthropic-batches-operation",
  );
  const betaCreateOperation = findLatestSpan(
    events,
    "anthropic-beta-create-operation",
  );
  const betaStreamOperation = findLatestSpan(
    events,
    "anthropic-beta-stream-operation",
  );

  return normalizeForSnapshot(
    [
      findLatestSpan(events, ROOT_NAME),
      createOperation,
      findAnthropicSpan(events, createOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      attachmentOperation,
      findAnthropicSpan(events, attachmentOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      streamOperation,
      findAnthropicSpan(events, streamOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      withResponseOperation,
      findAnthropicSpan(events, withResponseOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      toolStreamOperation,
      findAnthropicSpan(events, toolStreamOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      toolOperation,
      findAnthropicSpan(events, toolOperation?.span.id, [
        "anthropic.messages.create",
      ]),
      ...(supportsBatches
        ? [
            batchesOperation,
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.create",
            ]),
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.retrieve",
            ]),
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.list",
            ]),
            findAnthropicSpan(events, batchesOperation?.span.id, [
              "anthropic.messages.batches.cancel",
            ]),
          ]
        : []),
      ...(supportsBetaMessages
        ? [
            betaCreateOperation,
            findAnthropicSpan(events, betaCreateOperation?.span.id, [
              "anthropic.messages.create",
              "anthropic.beta.messages.create",
            ]),
            betaStreamOperation,
            findAnthropicSpan(events, betaStreamOperation?.span.id, [
              "anthropic.messages.create",
              "anthropic.beta.messages.create",
            ]),
          ]
        : []),
    ].map((event) => summarizeAnthropicPayload(event!)) as Json,
  );
}

export function defineAnthropicInstrumentationAssertions(options: {
  name: string;
  snapshotName: string;
  supportsBatches: boolean;
  supportsBetaMessages: boolean;
  testFileUrl: string;
  timeoutMs: number;
  runScenario: RunAnthropicScenario;
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

    test("captures trace for client.messages.create()", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "anthropic-create-operation");
      const span = findAnthropicSpan(events, operation?.span.id, [
        "anthropic.messages.create",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        provider: "anthropic",
      });
      expect(
        typeof (span?.row.metadata as { model?: unknown } | undefined)?.model,
      ).toBe("string");
    });

    test(
      "captures trace for client.messages.create().withResponse()",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "anthropic-create-with-response-operation",
        );
        const span = findAnthropicSpan(events, operation?.span.id, [
          "anthropic.messages.create",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          provider: "anthropic",
        });
        expect(
          typeof (span?.row.metadata as { model?: unknown } | undefined)?.model,
        ).toBe("string");
      },
    );

    test("captures trace for sending an attachment", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "anthropic-attachment-operation",
      );
      const span = findAnthropicSpan(events, operation?.span.id, [
        "anthropic.messages.create",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        provider: "anthropic",
      });
      expect(JSON.stringify(span?.input)).toContain("image.png");
    });

    test(
      "captures trace for client.messages.create({ stream: true })",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(events, "anthropic-stream-operation");
        const span = findAnthropicSpan(events, operation?.span.id, [
          "anthropic.messages.create",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          provider: "anthropic",
        });
        expect(span?.metrics).toMatchObject({
          time_to_first_token: expect.any(Number),
          prompt_tokens: expect.any(Number),
          completion_tokens: expect.any(Number),
        });
      },
    );

    test("captures trace for the second streaming path", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "anthropic-stream-with-response-operation",
      );
      const span = findAnthropicSpan(events, operation?.span.id, [
        "anthropic.messages.create",
      ]);

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        provider: "anthropic",
      });
      expect(span?.metrics).toMatchObject({
        time_to_first_token: expect.any(Number),
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
      });
    });

    test("captures trace for streamed tool use", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(
        events,
        "anthropic-stream-tool-operation",
      );
      const span = findAnthropicSpan(events, operation?.span.id, [
        "anthropic.messages.create",
      ]);
      const output = span?.output as
        | { content?: Array<{ name?: string; type?: string }> }
        | undefined;

      expect(operation).toBeDefined();
      expect(span).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(span?.row.metadata).toMatchObject({
        provider: "anthropic",
      });
      expect(span?.metrics).toMatchObject({
        time_to_first_token: expect.any(Number),
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
      });
      expect(
        output?.content?.some(
          (block) => block.type === "tool_use" && block.name === "get_weather",
        ),
      ).toBe(true);
    });

    test(
      "captures trace for client.messages.create() with tools",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(events, "anthropic-tool-operation");
        const span = findAnthropicSpan(events, operation?.span.id, [
          "anthropic.messages.create",
        ]);
        const output = span?.output as
          | { content?: Array<{ name?: string; type?: string }> }
          | undefined;

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.row.metadata).toMatchObject({
          provider: "anthropic",
        });
        expect(
          output?.content?.some(
            (block) =>
              block.type === "tool_use" && block.name === "get_weather",
          ),
        ).toBe(true);
      },
    );

    if (options.supportsBatches) {
      test(
        "captures traces for messages.batches operations",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const operation = findLatestSpan(
            events,
            "anthropic-batches-operation",
          );
          const createSpan = findAnthropicSpan(events, operation?.span.id, [
            "anthropic.messages.batches.create",
          ]);
          const retrieveSpan = findAnthropicSpan(events, operation?.span.id, [
            "anthropic.messages.batches.retrieve",
          ]);
          const listSpan = findAnthropicSpan(events, operation?.span.id, [
            "anthropic.messages.batches.list",
          ]);
          const cancelSpan = findAnthropicSpan(events, operation?.span.id, [
            "anthropic.messages.batches.cancel",
          ]);

          expect(operation).toBeDefined();
          expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
          expect(createSpan).toBeDefined();
          expect(retrieveSpan).toBeDefined();
          expect(listSpan).toBeDefined();
          expect(cancelSpan).toBeDefined();
          expect(
            (createSpan?.output as { id?: unknown } | undefined)?.id,
          ).toMatch(/^msgbatch_/);
        },
      );
    }

    if (options.supportsBetaMessages) {
      test(
        "captures trace for client.beta.messages.create()",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const operation = findLatestSpan(
            events,
            "anthropic-beta-create-operation",
          );
          const span = findAnthropicSpan(events, operation?.span.id, [
            "anthropic.messages.create",
            "anthropic.beta.messages.create",
          ]);

          expect(operation).toBeDefined();
          expect(span).toBeDefined();
          expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
          expect(span?.row.metadata).toMatchObject({
            provider: "anthropic",
          });
        },
      );

      test(
        "captures trace for client.beta.messages.create({ stream: true })",
        testConfig,
        () => {
          const root = findLatestSpan(events, ROOT_NAME);
          const operation = findLatestSpan(
            events,
            "anthropic-beta-stream-operation",
          );
          const span = findAnthropicSpan(events, operation?.span.id, [
            "anthropic.messages.create",
            "anthropic.beta.messages.create",
          ]);

          expect(operation).toBeDefined();
          expect(span).toBeDefined();
          expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
          expect(span?.row.metadata).toMatchObject({
            provider: "anthropic",
          });
          expect(span?.metrics).toMatchObject({
            time_to_first_token: expect.any(Number),
            prompt_tokens: expect.any(Number),
            completion_tokens: expect.any(Number),
          });
        },
      );
    }

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(
          buildSpanSummary(
            events,
            options.supportsBetaMessages,
            options.supportsBatches,
          ),
        ),
      ).toMatchFileSnapshot(spanSnapshotPath);
    });

    test("matches the shared payload snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(
          buildPayloadSummary(
            events,
            options.supportsBetaMessages,
            options.supportsBatches,
          ),
        ),
      ).toMatchFileSnapshot(payloadSnapshotPath);
    });
  });
}
