// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    ignoreBodyFields: [
      // Ignore all body fields — deterministic call order makes callIndex
      // the sole discriminator, which is stable across SDK releases.
      "**",
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
  },
];
