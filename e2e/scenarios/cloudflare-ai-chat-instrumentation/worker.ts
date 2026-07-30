import * as aiNamespace from "ai";
import * as aiChatNamespace from "@cloudflare/ai-chat";
import { createOpenAI } from "@ai-sdk/openai";
import { initLogger, wrapAISDK, wrapCloudflareAIChat } from "braintrust";
import { z } from "zod";

declare const __BRAINTRUST_API_KEY__: string;
declare const __BRAINTRUST_API_URL__: string;
declare const __BRAINTRUST_APP_URL__: string;
declare const __BRAINTRUST_PROJECT_NAME__: string;
declare const __BRAINTRUST_TEST_RUN_ID__: string;
declare const __CLOUDFLARE_AI_CHAT_MODE__: "auto" | "manual";
declare const __OPENAI_API_KEY__: string;
declare const __OPENAI_BASE_URL__: string;

const SCENARIO_NAME = "cloudflare-ai-chat-instrumentation";
const SUCCESS_ROOT_NAME = "cloudflare-ai-chat-success-root";
const ERROR_ROOT_NAME = "cloudflare-ai-chat-error-root";
const ERROR_MARKER = "CLOUDFLARE_AI_CHAT_STREAM_ERROR";
const SUCCESS_MARKER = "CLOUDFLARE_AI_CHAT_TOOL_OK";
const MODEL = "gpt-4.1-nano";

Object.assign(process.env, {
  BRAINTRUST_API_KEY: __BRAINTRUST_API_KEY__,
  BRAINTRUST_API_URL: __BRAINTRUST_API_URL__,
  BRAINTRUST_APP_URL: __BRAINTRUST_APP_URL__,
  BRAINTRUST_E2E_PROJECT_NAME: __BRAINTRUST_PROJECT_NAME__,
  BRAINTRUST_E2E_RUN_ID: __BRAINTRUST_TEST_RUN_ID__,
});

const ai =
  __CLOUDFLARE_AI_CHAT_MODE__ === "manual"
    ? wrapAISDK(aiNamespace)
    : aiNamespace;
const aiChat =
  __CLOUDFLARE_AI_CHAT_MODE__ === "manual"
    ? wrapCloudflareAIChat(aiChatNamespace)
    : aiChatNamespace;

export class ChatAgent extends aiChat.AIChatAgent {
  private scenarioKind: "error" | "success" = "success";

  async onChatMessage(
    _onFinish: unknown,
    _options?: { body?: { kind?: string } },
  ): Promise<Response> {
    if (this.scenarioKind === "error") {
      const stream = ai.createUIMessageStream({
        execute({ writer }) {
          writer.write({ type: "text-start", id: "error-text" });
          writer.write({
            type: "text-delta",
            id: "error-text",
            delta: "partial response",
          });
          throw new Error(ERROR_MARKER);
        },
        generateId: () => "assistant-error",
        onError: () => ERROR_MARKER,
        originalMessages: this.messages,
      });
      return ai.createUIMessageStreamResponse({ stream });
    }

    const openai = createOpenAI({
      apiKey: __OPENAI_API_KEY__,
      baseURL: __OPENAI_BASE_URL__,
    });
    const result = await ai.generateText({
      maxOutputTokens: 32,
      messages: await ai.convertToModelMessages(this.messages),
      model: openai(MODEL),
      stopWhen: ai.stepCountIs(2),
      system: `Call lookup_weather exactly once with city Vienna. After the tool returns, reply with exactly ${SUCCESS_MARKER} and no other text.`,
      temperature: 0,
      tools: {
        lookup_weather: ai.tool({
          description: "Return deterministic weather for one city.",
          execute: async ({ city }) => ({
            city,
            condition: "sunny",
            marker: "WEATHER_TOOL_EXECUTED",
          }),
          inputSchema: z.object({ city: z.string() }),
        }),
      },
    });
    const stream = ai.createUIMessageStream({
      execute({ writer }) {
        writer.write({ type: "text-start", id: "success-text" });
        writer.write({
          type: "text-delta",
          id: "success-text",
          delta: result.text,
        });
        writer.write({ type: "text-end", id: "success-text" });
      },
      generateId: () => "assistant-success",
      originalMessages: this.messages,
    });
    return ai.createUIMessageStreamResponse({ stream });
  }

  onChatResponse(_result: unknown): void {}

  async runInstrumentationScenario(kind: "error" | "success") {
    const logger = initLogger({ projectName: __BRAINTRUST_PROJECT_NAME__ });
    let result: Record<string, unknown>;
    try {
      this.scenarioKind = kind;
      let turnResult:
        | { error?: unknown; requestId: string; status: string }
        | undefined;
      await logger.traced(
        async () => {
          turnResult = await this.saveMessages([
            {
              id: `user-${kind}`,
              parts: [
                {
                  text:
                    kind === "success"
                      ? "Look up the weather in Vienna."
                      : "Produce a deterministic streaming error.",
                  type: "text",
                },
              ],
              role: "user",
            },
          ]);
        },
        {
          event: {
            metadata: {
              mode: __CLOUDFLARE_AI_CHAT_MODE__,
              scenario: SCENARIO_NAME,
              testRunId: __BRAINTRUST_TEST_RUN_ID__,
            },
          },
          name: kind === "success" ? SUCCESS_ROOT_NAME : ERROR_ROOT_NAME,
        },
      );
      result = {
        error:
          turnResult?.error instanceof Error
            ? turnResult.error.message
            : turnResult?.error,
        kind,
        messages: this.messages,
        ok: turnResult?.status === "completed",
        status: turnResult?.status,
      };
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error),
        kind,
        ok: false,
      };
    } finally {
      await logger.flush();
    }
    return result;
  }
}

export default {
  async fetch(request: Request, env: { CHAT_AGENT: any }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    if (url.pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }

    const kind = url.searchParams.get("kind") === "error" ? "error" : "success";
    const id = env.CHAT_AGENT.idFromName(
      `${__CLOUDFLARE_AI_CHAT_MODE__}-${kind}-${__BRAINTRUST_TEST_RUN_ID__}`,
    );
    const result =
      await env.CHAT_AGENT.get(id).runInstrumentationScenario(kind);
    return Response.json(result);
  },
};
