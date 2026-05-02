/**
 * Per-scenario seinfeld filter specs. Each entry maps a scenario/normalizer
 * name to a seinfeld FilterSpec, which is passed to createCassette({ filters }).
 *
 * Wildcard paths: `*` matches one segment, `**` matches any number.
 */

const AI_SDK_VOLATILE_FIELDS = {
  ignoreBodyFields: [
    // Strip ALL body fields so matching falls back to URL + method + callIndex.
    // The AI SDK scenarios make requests in a deterministic order; the cassette
    // entries are distinguished by position (callIndex), not by body content.
    // This avoids spurious misses caused by the SDK adding new default fields
    // between minor versions (e.g. Responses API drift: store, truncation, etc.)
    // or by schema format changes in tool definitions.
    "**",
    // (The specific field list below is kept for documentation purposes but
    // is superseded by the ** wildcard above.)
    // AI SDK volatile fields (change per-run)
    "experimental_generateMessageId",
    "messageId",
    "messages.*.id",
    "messages.*.experimental_messageId",
    "input.*.id",
    "input.*.experimental_messageId",
    // OpenAI Responses API fields added as defaults in newer client versions.
    // These don't affect request semantics but change between SDK releases.
    "store",
    "background",
    "truncation",
    "instructions",
    "moderation",
    "reasoning",
    "reasoning.effort",
    "reasoning.summary",
    "safety_identifier",
    "service_tier",
    "text",
    "text.format",
    "text.format.type",
    "text.verbosity",
    "metadata",
    "top_logprobs",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "parallel_tool_calls",
    "max_tool_calls",
    "prompt_cache_key",
    "prompt_cache_retention",
    "previous_response_id",
    "user",
    "include",
  ],
};

const MISTRAL_VOLATILE_FIELDS = {
  normalizeRequest: (req) => {
    if (
      req.body.kind !== "json" ||
      req.body.value === null ||
      typeof req.body.value !== "object" ||
      Array.isArray(req.body.value)
    ) {
      return req;
    }
    const value = /** @type {Record<string, unknown>} */ (req.body.value);
    if (
      typeof value["name"] === "string" &&
      /** @type {string} */ (value["name"]).startsWith("braintrust-e2e-")
    ) {
      return {
        ...req,
        body: {
          kind: "json",
          value: { ...value, name: "braintrust-e2e-<placeholder>" },
        },
      };
    }
    return req;
  },
};

export const CASSETTE_FILTERS = {
  default: "default",
  "ai-sdk": ["default", AI_SDK_VOLATILE_FIELDS],
  "ai-sdk-instrumentation": ["default", AI_SDK_VOLATILE_FIELDS],
  "ai-sdk-otel-export": ["default", AI_SDK_VOLATILE_FIELDS],
  "mistral-instrumentation": ["default", MISTRAL_VOLATILE_FIELDS],
};
