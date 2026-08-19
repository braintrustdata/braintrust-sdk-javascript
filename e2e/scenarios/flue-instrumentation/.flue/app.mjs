import { braintrustFlueInstrumentation, flush, initLogger } from "braintrust";
import { Hono } from "hono";

const runtimePackageName =
  process.env.FLUE_RUNTIME_PACKAGE_NAME ?? "@flue/runtime";
const [{ instrument, registerProvider }, { flue }] = await Promise.all([
  import(runtimePackageName),
  import(`${runtimePackageName}/routing`),
]);

function projectName() {
  const configured = process.env.BRAINTRUST_E2E_PROJECT_NAME;
  if (configured) {
    return configured;
  }
  const testRunId = process.env.BRAINTRUST_E2E_RUN_ID ?? "local";
  return `e2e-flue-instrumentation-${testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

initLogger({ projectName: projectName() });

instrument(braintrustFlueInstrumentation());

const openAIBaseUrl =
  process.env.OPENAI_BASE_URL ?? process.env.BRAINTRUST_E2E_MODEL_BASE_URL;
if (openAIBaseUrl) {
  registerProvider("openai", { baseUrl: openAIBaseUrl });
}

const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
if (anthropicBaseUrl) {
  registerProvider("anthropic", {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "test-key",
    baseUrl: anthropicBaseUrl,
  });
}

const app = new Hono();
app.route("/", flue());

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__braintrust_flush") {
      await flush();
      return new Response("ok");
    }
    return app.fetch(request, env, ctx);
  },
};
