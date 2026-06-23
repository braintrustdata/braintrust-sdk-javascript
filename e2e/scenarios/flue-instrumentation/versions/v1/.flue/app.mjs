import { instrument, registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { flush, initLogger } from "braintrust";
import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function projectName() {
  const configured = process.env.BRAINTRUST_E2E_PROJECT_NAME;
  if (configured) {
    return configured;
  }
  const testRunId = process.env.BRAINTRUST_E2E_RUN_ID ?? "local";
  return `e2e-flue-instrumentation-${testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

initLogger({ projectName: projectName() });

const exitProcess = process.exit.bind(process);
if (process.env.FLUE_E2E_FLUSH_FILE) {
  let isExiting = false;
  process.exit = (code) => {
    if (isExiting) {
      return exitProcess(code);
    }
    isExiting = true;
    const keepAlive = setTimeout(() => {}, 30_000);
    void flushBeforeExit()
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        clearTimeout(keepAlive);
        exitProcess(code);
      });
  };
}

if (process.env.FLUE_E2E_EXPLICIT_OBSERVE === "1") {
  const { braintrustFlueObserver } = await import("braintrust");
  instrument(braintrustFlueObserver);
}

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

let didScheduleFlush = false;
function scheduleFinalFlush(exitAfterFlush = false) {
  if (didScheduleFlush) {
    return;
  }
  didScheduleFlush = true;
  const keepAlive = setTimeout(() => {}, 30_000);
  void flushBeforeExit()
    .catch((error) => {
      console.error(error);
    })
    .finally(() => {
      clearTimeout(keepAlive);
      if (exitAfterFlush) {
        exitProcess(0);
      }
    });
}

process.on("SIGTERM", () => {
  scheduleFinalFlush(true);
});

process.on("beforeExit", () => {
  scheduleFinalFlush();
});

const app = new Hono();
app.route("/", flue());

async function flushBeforeExit() {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await flush();
  if (process.env.FLUE_E2E_FLUSH_FILE) {
    await mkdir(dirname(process.env.FLUE_E2E_FLUSH_FILE), {
      recursive: true,
    });
    await writeFile(process.env.FLUE_E2E_FLUSH_FILE, "ok");
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__braintrust_flush") {
      await flush();
      return new Response("ok");
    }
    return app.fetch(request, env, ctx);
  },
};
