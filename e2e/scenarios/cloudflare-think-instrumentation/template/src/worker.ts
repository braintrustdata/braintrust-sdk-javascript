import * as cloudflareThink from "@cloudflare/think";
import { createOpenAI } from "@ai-sdk/openai";
import { flush, initLogger, wrapCloudflareThink } from "braintrust";
import { tool } from "ai";
import { z } from "zod";

const OPENAI_MODEL = "gpt-5-nano";

type Env = {
  THINK_AGENT: DurableObjectNamespace<TestThink>;
};

const think =
  process.env.CLOUDFLARE_THINK_INSTRUMENTATION === "manual"
    ? wrapCloudflareThink(cloudflareThink)
    : cloudflareThink;

export class TestThink extends think.Think<Env> {
  async runE2ETurn() {
    if (!this.session) {
      await this.onStart();
    }
    return this.runTurn({
      input: "What is the weather in Vienna?",
      mode: "wait",
    });
  }

  getModel() {
    return createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }).chat(OPENAI_MODEL);
  }

  getSystemPrompt() {
    return [
      "You are a deterministic weather-test agent.",
      "You must call lookup_weather exactly once with Vienna before answering.",
      'After the tool result, reply with exactly: "Vienna is sunny and 21°C."',
    ].join(" ");
  }

  getTools() {
    return {
      lookup_weather: tool({
        description: "Get deterministic weather for a city.",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({
          city,
          condition: "sunny",
          degreesC: 21,
        }),
      }),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    configureBraintrust(url);
    const agent = env.THINK_AGENT.getByName(
      url.searchParams.get("agent") ?? "default",
    );
    const result = await agent.runE2ETurn();
    await flush();
    return Response.json(result);
  },
};

function configureBraintrust(url: URL): void {
  const appUrl = url.searchParams.get("braintrustAppUrl");
  const apiUrl = url.searchParams.get("braintrustApiUrl");
  if (!appUrl || !apiUrl) {
    throw new Error("Missing Braintrust E2E server URLs");
  }
  initLogger({
    apiKey: process.env.BRAINTRUST_API_KEY,
    appUrl,
    projectName:
      process.env.BRAINTRUST_E2E_PROJECT_NAME ||
      "cloudflare-think-instrumentation",
  });
}
