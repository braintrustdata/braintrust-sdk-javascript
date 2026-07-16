import { defineAgent, defineDynamic } from "eve";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { withReadableReasoning } from "./reasoning-model";

const openrouter = createOpenRouter({
  ...(process.env.OPENROUTER_BASE_URL
    ? { baseURL: process.env.OPENROUTER_BASE_URL }
    : {}),
});

const dynamicModel = withReadableReasoning(
  openrouter("qwen/qwen3-30b-a3b", {
    provider: {
      only: ["deepinfra"],
      require_parameters: true,
    },
  }),
);

export default defineAgent({
  model: defineDynamic({
    fallback: dynamicModel,
    events: {
      "step.started": () => dynamicModel,
    },
  }),
  modelContextWindowTokens: 8_192,
});
