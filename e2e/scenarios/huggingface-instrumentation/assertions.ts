import { beforeAll, describe, expect, test } from "vitest";
import { type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import {
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import {
  payloadRowsForRootSpan,
  summarizeWrapperContract,
} from "../../helpers/wrapper-contract";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunHuggingFaceScenario = (harness: {
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

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeChatOutput(output: Json | undefined): Json {
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
    const toolCalls = Array.isArray(message?.tool_calls)
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
    return {
      content:
        typeof content === "string"
          ? "<string>"
          : Array.isArray(content)
            ? "<array>"
            : (content ?? null),
      finish_reason: choice.finish_reason ?? null,
      index: choice.index ?? null,
      role: message?.role ?? null,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    } satisfies Json;
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

function summarizeProviderSpan(event: CapturedLogEvent): Json {
  const summary = summarizeWrapperContract(event, [
    "dimensions",
    "endpointUrl",
    "finish_reason",
    "model",
    "operation",
    "provider",
    "scenario",
  ]) as Record<string, Json>;

  switch (event.span.name) {
    case "huggingface.chat_completion":
    case "huggingface.chat_completion_stream":
      summary.output = summarizeChatOutput(event.output as Json);
      break;
    case "huggingface.text_generation":
    case "huggingface.text_generation_stream":
      summary.output = summarizeTextGenerationOutput(event.output as Json);
      break;
    case "huggingface.feature_extraction":
      summary.output = (event.output as Json) ?? null;
      break;
    default:
      break;
  }

  return summary;
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
      ["end", "start", "time_to_first_token"].includes(key)
    ) {
      normalized[key] = "<number>";
      continue;
    }

    normalized[key] = normalizeMetrics(entry as Json);
  }
  return normalized;
}

function normalizePayloadOutput(row: Json): Json {
  if (!isRecord(row)) {
    return row;
  }

  return "output" in row
    ? {
        ...row,
        output: normalizeLoggedOutput(row.output),
      }
    : row;
}

function normalizeLoggedOutput(output: Json): Json {
  if (Array.isArray(output)) {
    return summarizeChatOutput(output);
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
      choices: summarizeChatOutput(output.choices),
    };
  }

  return output;
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
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

  return [
    root ? summarizeWrapperContract(root, ["scenario"]) : null,
    chatOperation
      ? summarizeWrapperContract(chatOperation, ["operation"])
      : null,
    chatOperation
      ? summarizeProviderSpan(
          findLatestChildSpan(
            events,
            "huggingface.chat_completion",
            chatOperation.span.id,
          )!,
        )
      : null,
    chatStreamOperation
      ? summarizeWrapperContract(chatStreamOperation, ["operation"])
      : null,
    chatStreamOperation
      ? summarizeProviderSpan(
          findLatestChildSpan(
            events,
            "huggingface.chat_completion_stream",
            chatStreamOperation.span.id,
          )!,
        )
      : null,
    chatStreamToolCallOperation
      ? summarizeWrapperContract(chatStreamToolCallOperation, ["operation"])
      : null,
    chatStreamToolCallOperation
      ? summarizeProviderSpan(
          findLatestChildSpan(
            events,
            "huggingface.chat_completion_stream",
            chatStreamToolCallOperation.span.id,
          )!,
        )
      : null,
    textGenerationOperation
      ? summarizeWrapperContract(textGenerationOperation, ["operation"])
      : null,
    textGenerationOperation
      ? summarizeProviderSpan(
          findLatestChildSpan(
            events,
            "huggingface.text_generation",
            textGenerationOperation.span.id,
          )!,
        )
      : null,
    textGenerationStreamOperation
      ? summarizeWrapperContract(textGenerationStreamOperation, ["operation"])
      : null,
    textGenerationStreamOperation
      ? summarizeProviderSpan(
          findLatestChildSpan(
            events,
            "huggingface.text_generation_stream",
            textGenerationStreamOperation.span.id,
          )!,
        )
      : null,
    featureExtractionOperation
      ? summarizeWrapperContract(featureExtractionOperation, ["operation"])
      : null,
    featureExtractionOperation
      ? summarizeProviderSpan(
          findLatestChildSpan(
            events,
            "huggingface.feature_extraction",
            featureExtractionOperation.span.id,
          )!,
        )
      : null,
  ] satisfies Json;
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
    `${options.snapshotName}.span-events.json`,
  );
  const payloadSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.log-payloads.json`,
  );

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];
    let payloadRows: Json = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();

        const root = findLatestSpan(events, ROOT_NAME);
        payloadRows = payloadRowsForRootSpan(harness.payloads(), root?.span.id)
          .map((row) => normalizePayloadOutput(normalizeMetrics(row as Json)))
          .filter((row) => row !== null);
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
        await expect(
          formatJsonFileSnapshot(buildSpanSummary(events)),
        ).toMatchFileSnapshot(spanSnapshotPath);
      },
    );

    test(
      "matches the log payload snapshot",
      { timeout: options.timeoutMs },
      async ({ expect }) => {
        await expect(formatJsonFileSnapshot(payloadRows)).toMatchFileSnapshot(
          payloadSnapshotPath,
        );
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
        expect(toolCalls).toEqual([
          expect.objectContaining({
            function: expect.objectContaining({
              arguments: expect.any(String),
              name: "get_current_weather",
            }),
            type: "function",
          }),
        ]);
        expect(span?.output).toMatchObject({
          choices: [
            {
              finish_reason: "tool_calls",
            },
          ],
        });
      },
    );
  });
}
