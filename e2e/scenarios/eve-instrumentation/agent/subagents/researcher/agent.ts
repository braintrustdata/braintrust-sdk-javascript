import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";
import { withReadableReasoning } from "../../reasoning-model";

const openrouter = createOpenRouter({
  ...(process.env.OPENROUTER_BASE_URL
    ? { baseURL: process.env.OPENROUTER_BASE_URL }
    : {}),
});

export default defineAgent({
  description:
    "Research the Eve instrumentation documentation before the parent reads it.",
  model: withReadableReasoning(
    openrouter("qwen/qwen3-30b-a3b", {
      provider: {
        only: ["deepinfra"],
        require_parameters: true,
      },
    }),
  ),
  modelContextWindowTokens: 8_192,
});
