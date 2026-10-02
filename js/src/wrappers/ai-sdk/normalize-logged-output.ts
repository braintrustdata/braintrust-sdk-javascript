import type { AISDKResult } from "../../vendor-sdk-types/ai-sdk";
import { BaseAttachment } from "../../logger";

const REMOVE_NORMALIZED_VALUE = Symbol("braintrust.ai-sdk.remove-normalized");

export function normalizeAISDKLoggedOutput(
  value: unknown,
): Record<string, unknown> | AISDKResult {
  const normalized = normalizeAISDKLoggedValue(value);
  return normalized === REMOVE_NORMALIZED_VALUE
    ? {}
    : (normalized as Record<string, unknown> | AISDKResult);
}

function normalizeAISDKLoggedValue(
  value: unknown,
  context: { inProviderMetadata?: boolean; parentKey?: string } = {},
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeAISDKLoggedValue(entry, context))
      .filter((entry) => entry !== REMOVE_NORMALIZED_VALUE);
  }

  if (
    !value ||
    typeof value !== "object" ||
    value instanceof BaseAttachment ||
    value instanceof URL
  ) {
    return value;
  }

  const nextInProviderMetadata =
    context.inProviderMetadata ||
    context.parentKey === "providerMetadata" ||
    context.parentKey === "experimental_providerMetadata";
  const normalizedEntries: Array<[string, unknown]> = [];

  for (const [key, entry] of Object.entries(value)) {
    if (key === "cachedPromptTokens" && entry === 0) {
      continue;
    }
    if (
      context.parentKey === "request" &&
      key === "body" &&
      entry === "<omitted>"
    ) {
      continue;
    }

    const normalizedEntry = normalizeAISDKLoggedValue(entry, {
      inProviderMetadata: nextInProviderMetadata,
      parentKey: key,
    });
    if (normalizedEntry === REMOVE_NORMALIZED_VALUE) {
      continue;
    }
    normalizedEntries.push([key, normalizedEntry]);
  }

  if (normalizedEntries.length === 0) {
    if (context.parentKey === "request" || nextInProviderMetadata) {
      return REMOVE_NORMALIZED_VALUE;
    }
    return {};
  }

  return Object.fromEntries(normalizedEntries);
}
