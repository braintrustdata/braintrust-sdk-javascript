import { beforeAll, describe, expect, test } from "vitest";
import { type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
  type SpanTreeFields,
} from "../../helpers/span-tree";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunHuggingFaceScenario = (harness: {
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

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeChatOutput(
  output: Json | undefined,
  options?: {
    normalizeFinishReason?: boolean;
    omitToolCalls?: boolean;
  },
): Json {
  if (!Array.isArray(output)) {
    return null;
  }

  return output.map((choice) => {
    if (!isRecord(choice as Json)) {
      return choice as Json;
    }

    const message = isRecord(choice.message as Json)
      ? (choice.message as Record<string, Json>)
      : undefined;
    const content = message?.content;
    const toolCalls =
      !options?.omitToolCalls && Array.isArray(message?.tool_calls)
        ? message.tool_calls.map((toolCall) => {
            if (!isRecord(toolCall as Json)) {
              return toolCall as Json;
            }

            const toolFunction = isRecord(toolCall.function as Json)
              ? (toolCall.function as Record<string, Json>)
              : undefined;
            return {
              id: toolCall.id ?? null,
              index: toolCall.index ?? null,
              name: toolFunction?.name ?? null,
              type: toolCall.type ?? null,
              arguments:
                typeof toolFunction?.arguments === "string"
                  ? "<string>"
                  : (toolFunction?.arguments ?? null),
            } satisfies Json;
          })
        : undefined;
    const summary: Record<string, Json> = {
      content:
        typeof content === "string"
          ? "<string>"
          : Array.isArray(content)
            ? "<array>"
            : (content ?? null),
      finish_reason:
        options?.normalizeFinishReason &&
        typeof choice.finish_reason === "string"
          ? "<string>"
          : (choice.finish_reason ?? null),
      index: choice.index ?? null,
      role: message?.role ?? null,
    };

    if (toolCalls) {
      summary.tool_calls = toolCalls;
    }

    return summary satisfies Json;
  });
}

function summarizeTextGenerationOutput(output: Json | undefined): Json {
  if (!isRecord(output)) {
    return output ?? null;
  }

  const generatedText = output.generated_text;
  return {
    ...output,
    generated_text:
      typeof generatedText === "string" ? "<string>" : (generatedText ?? null),
  } satisfies Json;
}

function normalizeEndpointUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      return value;
    }

    if (url.pathname.startsWith("/huggingface-router")) {
      return `https://router.huggingface.co${url.pathname.slice("/huggingface-router".length)}${url.search}${url.hash}`;
    }
    if (url.pathname.startsWith("/huggingface")) {
      return `https://huggingface.co${url.pathname.slice("/huggingface".length)}${url.search}${url.hash}`;
    }
  } catch {
    return value;
  }

  return value;
}

function normalizeEndpointUrls(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeEndpointUrls(entry as Json));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] =
      key === "endpointUrl" && typeof entry === "string"
        ? normalizeEndpointUrl(entry)
        : normalizeEndpointUrls(entry as Json);
  }
  return normalized;
}

function normalizeMetrics(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMetrics(entry as Json));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "prompt_cached_tokens") {
      continue;
    }

    if (
      typeof entry === "number" &&
      [
        "completion_tokens",
        "end",
        "prompt_tokens",
        "start",
        "time_to_first_token",
        "tokens",
      ].includes(key)
    ) {
      normalized[key] = "<number>";
      continue;
    }

    normalized[key] = normalizeMetrics(entry as Json);
  }
  return normalized;
}

function normalizeModelNames(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeModelNames(entry as Json));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] =
      key === "model" ? "<model>" : normalizeModelNames(entry as Json);
  }
  return normalized;
}

function normalizeLoggedOutput(
  output: Json,
  options?: {
    normalizeFinishReason?: boolean;
    omitToolCalls?: boolean;
  },
): Json {
  if (Array.isArray(output)) {
    return summarizeChatOutput(output, options);
  }

  if (!isRecord(output)) {
    return output;
  }

  if ("generated_text" in output) {
    return summarizeTextGenerationOutput(output);
  }

  if (Array.isArray(output.choices)) {
    return {
      ...output,
      choices: summarizeChatOutput(output.choices, options),
    };
  }

  return output;
}

function snapshotFields(event: CapturedLogEvent): SpanTreeFields {
  const fields = spanTreeFields(event);
  const output =
    event.output === undefined
      ? undefined
      : normalizeLoggedOutput(event.output as Json, {
          normalizeFinishReason: true,
          omitToolCalls: true,
        });

  return normalizeEndpointUrls(
    normalizeModelNames({
      ...fields,
      metrics: normalizeMetrics(fields.metrics as Json),
      ...(output === undefined ? {} : { output }),
    } as Json),
  ) as SpanTreeFields;
}

function buildSpanTree(events: CapturedLogEvent[]): SpanTreeEntry[] {
  const root = findLatestSpan(events, ROOT_NAME);
  const chatOperation = findLatestSpan(events, "huggingface-chat-operation");
  const chatStreamOperation = findLatestSpan(
    events,
    "huggingface-chat-stream-operation",
  );
  const chatStreamToolCallOperation = findLatestSpan(
    events,
    "huggingface-chat-stream-tool-call-operation",
  );
  const textGenerationOperation = findLatestSpan(
    events,
    "huggingface-text-generation-operation",
  );
  const textGenerationStreamOperation = findLatestSpan(
    events,
    "huggingface-text-generation-stream-operation",
  );
  const featureExtractionOperation = findLatestSpan(
    events,
    "huggingface-feature-extraction-operation",
  );

  const relevantEvents = [
    root,
    chatOperation,
    chatOperation
      ? findLatestChildSpan(
          events,
          "huggingface.chat_completion",
          chatOperation.span.id,
        )
      : undefined,
    chatStreamOperation,
    chatStreamOperation
      ? findLatestChildSpan(
          events,
          "huggingface.chat_completion_stream",
          chatStreamOperation.span.id,
        )
      : undefined,
    chatStreamToolCallOperation,
    chatStreamToolCallOperation
      ? findLatestChildSpan(
          events,
          "huggingface.chat_completion_stream",
          chatStreamToolCallOperation.span.id,
        )
      : undefined,
    textGenerationOperation,
    textGenerationOperation
      ? findLatestChildSpan(
          events,
          "huggingface.text_generation",
          textGenerationOperation.span.id,
        )
      : undefined,
    textGenerationStreamOperation,
    textGenerationStreamOperation
      ? findLatestChildSpan(
          events,
          "huggingface.text_generation_stream",
          textGenerationStreamOperation.span.id,
        )
      : undefined,
    featureExtractionOperation,
    featureExtractionOperation
      ? findLatestChildSpan(
          events,
          "huggingface.feature_extraction",
          featureExtractionOperation.span.id,
        )
      : undefined,
  ];

  return relevantEvents.flatMap((event) =>
    event ? [{ event, fields: snapshotFields(event) }] : [],
  );
}

export function defineHuggingFaceInstrumentationAssertions(options: {
  name: string;
  runScenario: RunHuggingFaceScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
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

    test(
      "captures the root trace for the scenario",
      { timeout: options.timeoutMs },
      () => {
        const root = findLatestSpan(events, ROOT_NAME);

        expect(root).toBeDefined();
        expect(root?.row.metadata).toMatchObject({
          scenario: SCENARIO_NAME,
        });
      },
    );

    test(
      "matches the span contract snapshot",
      { timeout: options.timeoutMs },
      async ({ expect }) => {
        await matchSpanTreeSnapshot(events, spanSnapshotPath);
      },
    );

    test(
      "captures streamed tool calls and request tool metadata",
      { timeout: options.timeoutMs },
      () => {
        const operation = findLatestSpan(
          events,
          "huggingface-chat-stream-tool-call-operation",
        );
        const span = findLatestChildSpan(
          events,
          "huggingface.chat_completion_stream",
          operation?.span.id,
        );
        const firstChoice = isRecord(span?.output as Json)
          ? span?.output.choices
          : undefined;
        const firstMessage =
          Array.isArray(firstChoice) && isRecord(firstChoice[0] as Json)
            ? (((firstChoice[0] as Record<string, Json>).message as Json) ??
              null)
            : null;
        const message = isRecord(firstMessage) ? firstMessage : undefined;
        const toolCalls = Array.isArray(message?.tool_calls)
          ? message.tool_calls
          : undefined;
        const choice =
          Array.isArray(firstChoice) && isRecord(firstChoice[0] as Json)
            ? (firstChoice[0] as Record<string, Json>)
            : undefined;
        const finishReason =
          typeof choice?.finish_reason === "string"
            ? choice.finish_reason
            : undefined;

        expect(span?.metadata).toMatchObject({
          model: expect.any(String),
          provider: "featherless-ai",
          tool_choice: "required",
          tools: [
            {
              function: {
                name: "get_current_weather",
              },
              type: "function",
            },
          ],
        });

        if (toolCalls) {
          expect(toolCalls).toEqual([
            expect.objectContaining({
              function: expect.objectContaining({
                arguments: expect.any(String),
                name: "get_current_weather",
              }),
              type: "function",
            }),
          ]);
          expect(finishReason).toBe("tool_calls");
          return;
        }

        expect(finishReason).toEqual(expect.any(String));
      },
    );
  });
}
