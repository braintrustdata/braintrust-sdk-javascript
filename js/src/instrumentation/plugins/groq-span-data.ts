import { processInputAttachments } from "../../wrappers/attachment-utils";
import type { GroqChatCompletion } from "../../vendor-sdk-types/groq";
import { isObject } from "../../../util/index";

const GROQ_COMPLETION_METADATA_KEYS = [
  "model",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "response_format",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tool_calls",
  "reasoning_format",
  "reasoning_effort",
  "seed",
] as const;

export function extractGroqCompletionInput(params: Record<string, unknown>): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const metadata: Record<string, unknown> = { provider: "groq" };
  for (const key of GROQ_COMPLETION_METADATA_KEYS) {
    try {
      const value = Reflect.get(params, key);
      if (value !== undefined) {
        metadata[key] = value;
      }
    } catch {
      // Ignore hostile getters in provider input.
    }
  }
  let messages: unknown;
  try {
    messages = Reflect.get(params, "messages");
  } catch {
    // Ignore hostile getters in provider input.
  }
  return {
    input: processInputAttachments(messages),
    metadata,
  };
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readNonnegativeInteger(
  value: unknown,
  key: PropertyKey,
): number | undefined {
  const result = readProperty(value, key);
  return typeof result === "number" &&
    Number.isSafeInteger(result) &&
    result >= 0
    ? result
    : undefined;
}

export function parseGroqMetrics(
  result:
    | Pick<GroqChatCompletion, "usage" | "x_groq">
    | { usage?: unknown; x_groq?: unknown }
    | null
    | undefined,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  const usage = readProperty(result, "usage");
  const xGroq = readProperty(result, "x_groq");

  for (const [source, target] of [
    ["prompt_tokens", "prompt_tokens"],
    ["input_tokens", "prompt_tokens"],
    ["completion_tokens", "completion_tokens"],
    ["output_tokens", "completion_tokens"],
    ["total_tokens", "tokens"],
  ] as const) {
    const value = readNonnegativeInteger(usage, source);
    if (value !== undefined && metrics[target] === undefined) {
      metrics[target] = value;
    }
  }

  if (
    metrics.tokens === undefined &&
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  ) {
    const total = metrics.prompt_tokens + metrics.completion_tokens;
    if (Number.isSafeInteger(total)) {
      metrics.tokens = total;
    }
  }

  const promptDetails =
    readProperty(usage, "prompt_tokens_details") ??
    readProperty(usage, "input_tokens_details");
  const completionDetails =
    readProperty(usage, "completion_tokens_details") ??
    readProperty(usage, "output_tokens_details");
  const promptCachedTokens = readNonnegativeInteger(
    promptDetails,
    "cached_tokens",
  );
  const completionReasoningTokens = readNonnegativeInteger(
    completionDetails,
    "reasoning_tokens",
  );
  if (
    promptCachedTokens !== undefined &&
    (metrics.prompt_tokens === undefined ||
      promptCachedTokens <= metrics.prompt_tokens)
  ) {
    metrics.prompt_cached_tokens = promptCachedTokens;
  }
  if (
    completionReasoningTokens !== undefined &&
    (metrics.completion_tokens === undefined ||
      completionReasoningTokens <= metrics.completion_tokens)
  ) {
    metrics.completion_reasoning_tokens = completionReasoningTokens;
  }

  if (!isObject(xGroq)) {
    return metrics;
  }

  const extraUsage = readProperty(xGroq, "usage");
  if (!isObject(extraUsage)) {
    return metrics;
  }

  const dramCachedTokens = readNonnegativeInteger(
    extraUsage,
    "dram_cached_tokens",
  );
  const sramCachedTokens = readNonnegativeInteger(
    extraUsage,
    "sram_cached_tokens",
  );
  let groqCachedTokens: number | undefined;
  if (dramCachedTokens !== undefined || sramCachedTokens !== undefined) {
    const total = (dramCachedTokens ?? 0) + (sramCachedTokens ?? 0);
    if (!Number.isSafeInteger(total)) {
      return metrics;
    }
    groqCachedTokens = total;
  }

  if (
    metrics.prompt_cached_tokens === undefined &&
    groqCachedTokens !== undefined &&
    metrics.prompt_tokens !== undefined &&
    groqCachedTokens <= metrics.prompt_tokens
  ) {
    metrics.prompt_cached_tokens = groqCachedTokens;
  }
  return metrics;
}
