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
import { aiSDKChannels } from "./ai-sdk-channels";

try {
  configureNode();
} catch {}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
              controller.enqueue({
                type: "raw",
                rawValue: {
                  type: "response.created",
                  response: { id: "response-id" },
                },
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
      includeRawChunks: true,
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

  test("streamText time_to_first_token counts streamed tool input arguments", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const contentDelayMs = 80;
    let sentContent = false;
    const result = (await aiSDKChannels.streamText.tracePromise(
      async () => ({
        baseStream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "ignored-text" });
            controller.enqueue({
              type: "tool-input-start",
              id: "call-1",
              toolName: "lookup",
            });
          },
          async pull(controller) {
            if (sentContent) {
              controller.close();
              return;
            }

            sentContent = true;
            await sleep(contentDelayMs);
            controller.enqueue({
              type: "tool-input-delta",
              id: "call-1",
              inputTextDelta: '{"query"',
            });
            controller.close();
          },
        }),
      }),
      {
        arguments: [
          {
            model: "mock-tool-model",
            prompt: "Call the lookup tool.",
          },
        ],
      } as any,
    )) as any;

    const reader = result.baseStream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamText",
    );

    expect(streamTextSpan?.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
      contentDelayMs / 1000 / 2,
    );
  });
});
