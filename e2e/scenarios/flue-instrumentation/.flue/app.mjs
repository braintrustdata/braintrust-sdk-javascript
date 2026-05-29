import { configureProvider, flue, observe } from "@flue/runtime/app";
import { flush, initLogger } from "braintrust";

function projectName() {
  const configured = process.env.BRAINTRUST_E2E_PROJECT_NAME;
  if (configured) {
    return configured;
  }
  const testRunId = process.env.BRAINTRUST_E2E_RUN_ID ?? "local";
  return `e2e-flue-instrumentation-${testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

initLogger({ projectName: projectName() });

if (process.env.FLUE_E2E_EXPLICIT_OBSERVE === "1") {
  const { braintrustFlueObserver } = await import("braintrust");
  observe(braintrustFlueObserver);
}

const openAIBaseUrl =
  process.env.OPENAI_BASE_URL ?? process.env.BRAINTRUST_E2E_MODEL_BASE_URL;
if (openAIBaseUrl) {
  configureProvider("openai", { baseUrl: openAIBaseUrl });
}

const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
if (anthropicBaseUrl) {
  configureProvider("anthropic", {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "test-key",
    baseUrl: anthropicBaseUrl,
  });
}

let didScheduleFlush = false;
process.on("beforeExit", () => {
  if (didScheduleFlush) {
    return;
  }
  didScheduleFlush = true;
  void flush();
});

const app = flue();

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__braintrust_flush") {
      await flush();
      return new Response("ok");
    }
    return app.fetch(request, env, ctx);
  },
};
