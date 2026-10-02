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

const providerInstrumentation =
  process.env.EVE_INSTRUMENTATION_PROVIDER === "1";

export default defineAgent({
  ...(process.env.EVE_EXPERIMENTAL_INSTRUMENTATION_PROVIDERS === "1"
    ? { experimental: { instrumentationProviders: true } }
    : {}),
  model: defineDynamic({
    ...(providerInstrumentation ? {} : { fallback: dynamicModel }),
    events: {
      "step.started": () =>
        providerInstrumentation
          ? { model: dynamicModel, modelContextWindowTokens: 32_768 }
          : dynamicModel,
    },
  } as never),
  ...(providerInstrumentation ? {} : { modelContextWindowTokens: 32_768 }),
} as never);
