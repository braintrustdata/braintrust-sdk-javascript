/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  TestBackgroundLogger,
} from "../../logger";
import { configureNode } from "../../node/config";
import { wrapAISDK } from "./ai-sdk";

try {
  configureNode();
} catch {}

describe("ai sdk generateImage wrapper", () => {
  let backgroundLogger: TestBackgroundLogger;

  beforeEach(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "ai-sdk-generate-image.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("logs generated images as attachments", async () => {
    const generateImage = vi.fn(async () => ({
      image: {
        base64: "aGVsbG8=",
        mediaType: "image/png",
      },
      images: [
        {
          base64: "aGVsbG8=",
          mediaType: "image/png",
        },
      ],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      warnings: [],
    }));
    const wrapped = wrapAISDK({ generateImage } as any);

    const result = await wrapped.generateImage({
      model: { modelId: "image-model", provider: "test-provider" },
      prompt: "A test image",
      n: 1,
      size: "1024x1024",
      headers: { authorization: "secret" },
    });

    expect(result.images).toHaveLength(1);
    expect(generateImage).toHaveBeenCalledOnce();

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);

    const span = spans[0] as any;
    expect(span.span_attributes).toMatchObject({
      name: "generateImage",
      type: "function",
    });
    expect(span.input).toMatchObject({
      prompt: "A test image",
      n: 1,
      size: "1024x1024",
    });
    expect(span.input).not.toHaveProperty("headers");
    expect(span.metadata).toMatchObject({
      model: "image-model",
      provider: "test-provider",
    });
    expect(span.metrics).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 4,
      tokens: 7,
    });
    expect(span.output.image).toBeUndefined();
    expect(span.output.images).toHaveLength(1);
    expect(span.output.images[0].reference).toMatchObject({
      type: "braintrust_attachment",
      content_type: "image/png",
    });
    expect(JSON.stringify(span.output)).not.toContain("aGVsbG8=");
  });
});
