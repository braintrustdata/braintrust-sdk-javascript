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
    entry?: string;
    nodeArgs: string[];
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry?: string;
    runContext?: { variantKey: string };
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

  if (
    event.span.name !== "anthropic.messages.create" ||
    !Array.isArray((summary.output as { content?: unknown[] } | null)?.content)
  ) {
    return summary;
  }

  const output = structuredClone(
    summary.output as {
      content: Array<{
        caller?: unknown;
        input?: Record<string, unknown>;
        name?: string;
        id?: string;
        text?: string;
        type?: string;
        thinking?: string;
        signature?: string;
      }>;
    },
  );

  const hasThinkingBlock = output.content.some(
    (block) => block.type === "thinking",
  );

  if (hasThinkingBlock) {
    for (const block of output.content) {
      if (block.type === "thinking") {
        block.thinking = "<thinking-content>";
        delete block.signature;
      } else if (block.type === "text" && typeof block.text === "string") {
        block.text = "<thinking-answer>";
      }
    }
    summary.output = output as Json;
    // Thinking token counts vary per run (temperature=1, variable thinking depth).
    // Zero them out so the payload snapshot is stable.
    if (summary.metrics && typeof summary.metrics === "object") {
      const metrics = summary.metrics as Record<string, Json>;
      for (const key of ["completion_tokens", "tokens"]) {
        if (key in metrics) {
          metrics[key] = 0;
        }
      }
    }
    return summary;
  }

  // `caller` is only present in newer Anthropic SDK responses.
  // Drop it so payload snapshots stay stable across SDK versions.
  for (const block of output.content) {
    if (
      (block.type === "tool_use" || block.type === "server_tool_use") &&
      "caller" in block
    ) {
      delete block.caller;
    }
  }

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
  supportsThinking: boolean,
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
  const thinkingStreamOperation = findLatestSpan(
    events,
    "anthropic-stream-thinking-operation",
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
      ...(supportsThinking
        ? [
            thinkingStreamOperation,
            findAnthropicSpan(events, thinkingStreamOperation?.span.id, [
              "anthropic.messages.create",
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
  supportsThinking: boolean,
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
  const thinkingStreamOperation = findLatestSpan(
    events,
    "anthropic-stream-thinking-operation",
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
      ...(supportsThinking
        ? [
            thinkingStreamOperation,
            findAnthropicSpan(events, thinkingStreamOperation?.span.id, [
              "anthropic.messages.create",
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
  supportsBetaMessages: boolean;
  supportsServerToolUse: boolean;
  supportsThinking: boolean;
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

    if (options.supportsServerToolUse) {
      test("captures server tool usage metrics", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "anthropic-server-tool-use-operation",
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
        const metrics = (span?.metrics ?? {}) as Record<string, unknown>;
        if ("server_tool_use_web_search_requests" in metrics) {
          expect(metrics.server_tool_use_web_search_requests).toEqual(
            expect.any(Number),
          );
        } else {
          expect(metrics).toMatchObject({
            completion_tokens: expect.any(Number),
            prompt_tokens: expect.any(Number),
            tokens: expect.any(Number),
          });
        }
        expect(
          output?.content?.some(
            (block) =>
              block.type === "server_tool_use" && block.name === "web_search",
          ),
        ).toBe(true);
      });
    }

    if (options.supportsThinking) {
      test("captures trace for streaming extended thinking", testConfig, () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "anthropic-stream-thinking-operation",
        );
        const span = findAnthropicSpan(events, operation?.span.id, [
          "anthropic.messages.create",
        ]);
        const output = span?.output as
          | { content?: Array<{ type?: string }> }
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
          output?.content?.some((block) => block.type === "thinking"),
        ).toBe(true);
        expect(output?.content?.some((block) => block.type === "text")).toBe(
          true,
        );
      });
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
            options.supportsThinking,
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
            options.supportsThinking,
          ),
        ),
      ).toMatchFileSnapshot(payloadSnapshotPath);
    });
  });
}
