/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import * as ai from "ai";
import { configureNode } from "../../node/config";
import {
  _exportsForTestingOnly,
  initLogger,
  Logger,
  TestBackgroundLogger,
} from "../../logger";
import { wrapAISDK } from "../../wrappers/ai-sdk";

try {
  configureNode();
} catch {}

describe("AI SDK streaming instrumentation", () => {
  let backgroundLogger: TestBackgroundLogger;
  let _logger: Logger<false>;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    _logger = initLogger({
      projectName: "ai-sdk-plugin.streaming.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("streamText time_to_first_token ignores AI SDK v6 framing chunks", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const requestDelayMs = 40;
    const contentDelayMs = 80;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    let sentContent = false;
    const model = {
      specificationVersion: "v3",
      provider: "mock-delayed-provider",
      modelId: "mock-delayed-model",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("doGenerate should not be called");
      },
      doStream: async () => {
        await sleep(requestDelayMs);

        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "response-metadata",
                id: "response-id",
                modelId: "mock-delayed-model",
                timestamp: new Date(0),
              });
            },
            async pull(controller) {
              if (sentContent) {
                controller.close();
                return;
              }

              sentContent = true;
              await sleep(contentDelayMs);
              controller.enqueue({ type: "text-start", id: "delayed-text" });
              controller.enqueue({
                type: "text-delta",
                id: "delayed-text",
                delta: "DELAYED",
              });
              controller.enqueue({ type: "text-end", id: "delayed-text" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  outputTokens: {
                    total: 1,
                    text: 1,
                    reasoning: 0,
                  },
                },
              });
            },
          }),
          warnings: [],
        };
      },
    } as any;

    const wrappedAI = wrapAISDK(ai);
    const result = wrappedAI.streamText({
      model,
      prompt: "Reply with exactly DELAYED.",
      maxOutputTokens: 16,
    });

    let fullText = "";
    for await (const chunk of result.textStream) {
      fullText += chunk;
    }
    await result.text;

    expect(fullText).toBe("DELAYED");

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamText",
    );
    const doStreamSpan = spans.find(
      (s) => s?.span_attributes?.name === "doStream",
    );
    const minimumExpectedTTFT = (requestDelayMs + contentDelayMs) / 1000 / 2;

    expect(streamTextSpan?.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
      minimumExpectedTTFT,
    );
    expect(doStreamSpan?.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
      minimumExpectedTTFT,
    );
    expect(streamTextSpan?.output?.text).toBe("DELAYED");
    expect(doStreamSpan?.output?.text).toBe("DELAYED");
  });
});
