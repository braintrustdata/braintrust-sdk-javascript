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
  ...(providerInstrumentation
    ? { experimental: { instrumentationProviders: true } }
    : {}),
  model: defineDynamic({
    ...(providerInstrumentation ? {} : { fallback: dynamicModel }),
    events: {
      "step.started": () =>
        providerInstrumentation
          ? { model: dynamicModel, modelContextWindowTokens: 8_192 }
          : dynamicModel,
    },
  } as never),
  ...(providerInstrumentation ? {} : { modelContextWindowTokens: 8_192 }),
} as never);
