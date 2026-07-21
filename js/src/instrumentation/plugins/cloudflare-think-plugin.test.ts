/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as ai from "ai";
import { configureNode } from "../../node/config";
import {
  _exportsForTestingOnly,
  initLogger,
  type TestBackgroundLogger,
} from "../../logger";
import { wrapAISDK } from "../../wrappers/ai-sdk";
import { wrapCloudflareThink } from "../../wrappers/cloudflare-think";
import { cloudflareThinkSpanCountForTesting } from "./cloudflare-think-context";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("Cloudflare Think instrumentation", () => {
  let backgroundLogger: TestBackgroundLogger;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "cloudflare-think-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    expect(cloudflareThinkSpanCountForTesting()).toBe(0);
  });

  it("creates one task with the model call directly beneath it", async () => {
    const wrappedAI = wrapAISDK(ai);
    const model = makeStreamingModel("Hello from Think");
    class Think {
      messages = [{ role: "user", content: "Say hello" }];

      async _runInferenceLoop() {
        return wrappedAI.streamText({
          model,
          messages: this.messages,
        });
      }
    }
    const { Think: WrappedThink } = wrapCloudflareThink({ Think });
    const result = await new WrappedThink()._runInferenceLoop();

    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }
    await result.text;
    expect(text).toBe("Hello from Think");

    const spans = (await backgroundLogger.drain()) as any[];
    const task = spans.find(
      (span) => span.span_attributes?.name === "Think.runTurn",
    );
    const modelSpan = spans.find(
      (span) => span.span_attributes?.name === "doStream",
    );

    expect(spans).toHaveLength(2);
    expect(task).toMatchObject({
      span_attributes: { name: "Think.runTurn", type: "task" },
      input: [{ role: "user", content: "Say hello" }],
      output: { role: "assistant", content: "Hello from Think" },
      metadata: {
        braintrust: {
          integration_name: "cloudflare-think",
          sdk_language: "typescript",
        },
        model: "think-model",
        provider: "think-provider",
      },
      metrics: {
        completion_tokens: 4,
        prompt_tokens: 3,
        tokens: 7,
      },
    });
    expect(modelSpan?.span_parents).toEqual([task?.span_id]);
    expect(
      spans.some((span) => span.span_attributes?.name === "streamText"),
    ).toBe(false);
  });

  it("records failures and releases the active Think context", async () => {
    const error = new Error("inference failed");
    class Think {
      messages = [{ role: "user", content: "Fail now" }];

      async _runInferenceLoop() {
        throw error;
      }
    }
    const { Think: WrappedThink } = wrapCloudflareThink({ Think });

    await expect(new WrappedThink()._runInferenceLoop()).rejects.toBe(error);

    const spans = (await backgroundLogger.drain()) as any[];
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      input: [{ role: "user", content: "Fail now" }],
      span_attributes: { name: "Think.runTurn", type: "task" },
    });
    expect(spans[0].error).toBeDefined();
  });
});

function makeStreamingModel(text: string): any {
  return {
    specificationVersion: "v3",
    provider: "think-provider",
    modelId: "think-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate should not be called");
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({ type: "text-delta", id: "text-1", delta: text });
          controller.enqueue({ type: "text-end", id: "text-1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 3,
                noCache: 3,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: {
                total: 4,
                text: 4,
                reasoning: 0,
              },
            },
          });
          controller.close();
        },
      }),
      warnings: [],
    }),
  };
}
