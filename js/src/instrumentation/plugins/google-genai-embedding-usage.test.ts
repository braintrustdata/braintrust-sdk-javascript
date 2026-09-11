import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, initLogger, traced } from "../../logger";
import { configureNode } from "../../node/config";
import { wrapGoogleGenAI } from "../../wrappers/google-genai";
import type { GoogleGenAIEmbedContentResponse } from "../../vendor-sdk-types/google-genai";

configureNode();

describe("Google GenAI embedding HTTP usage", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "tmp-luca-google-genai-embedding-usage",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("captures raw usage on the correct concurrent span without changing SDK results", async () => {
    class HttpResponse {
      constructor(private response: GoogleGenAIEmbedContentResponse) {}
      json() {
        return Promise.resolve(this.response);
      }
    }
    const results = new Map<string, GoogleGenAIEmbedContentResponse>();
    const sdk = {
      HttpResponse,
      GoogleGenAI: class {
        chats = {};
        models = {
          embedContent: async (params: { model: string; contents: string }) => {
            await new Promise((resolve) =>
              setTimeout(resolve, params.contents === "first" ? 10 : 0),
            );
            const tokens = params.contents === "first" ? 11 : 29;
            const raw = await new HttpResponse({
              embeddings: [{ values: [0.1, 0.2] }],
              usageMetadata: {
                promptTokenCount: tokens,
                promptTokenDetails: [{ modality: "AUDIO", tokenCount: 3 }],
              },
            }).json();
            // Mirror Google's converter, which discards raw usageMetadata.
            const result = { embeddings: raw.embeddings };
            results.set(params.contents, result);
            return result;
          },
        };
      },
    };
    const wrapped = wrapGoogleGenAI(sdk);
    const patchedJson = HttpResponse.prototype.json;
    wrapGoogleGenAI(sdk);
    expect(HttpResponse.prototype.json).toBe(patchedJson);
    const client = new wrapped.GoogleGenAI();
    const [first, second] = await Promise.all(
      ["first", "second"].map((contents) =>
        client.models.embedContent({ model: "gemini-embedding-2", contents }),
      ),
    );
    expect(first).toBe(results.get("first"));
    expect(second).toBe(results.get("second"));
    expect(first).not.toHaveProperty("usageMetadata");

    // Parsing other provider responses must not log embedding usage on a task.
    await traced(
      async () => {
        await new HttpResponse({
          usageMetadata: { promptTokenCount: 999 },
        }).json();
      },
      { name: "unrelated task" },
    );

    const spans = await backgroundLogger.drain();
    const embeddingSpans = spans.filter(
      (span: any) => span.span_attributes?.name === "embed_content",
    ) as Record<string, any>[];
    expect(embeddingSpans).toHaveLength(2);
    for (const [contents, tokens] of [
      ["first", 11],
      ["second", 29],
    ]) {
      const span = embeddingSpans.find(
        (span) => span.input.inputs[0].content === contents,
      );
      expect(span).toMatchObject({
        output: { count: 1 },
        metrics: { prompt_tokens: tokens, tokens, prompt_audio_tokens: 3 },
      });
      expect(span?.metrics).not.toHaveProperty("completion_tokens");
    }
    const task = spans.find(
      (span: any) => span.span_attributes?.name === "unrelated task",
    ) as Record<string, any>;
    expect(task.metrics).not.toHaveProperty("prompt_tokens");
  });

  it("preserves HTTP response promise identity and errors", async () => {
    const error = new Error("invalid JSON");
    const promise = Promise.reject(error);
    class HttpResponse {
      json() {
        return promise;
      }
    }
    const wrapped = wrapGoogleGenAI({
      HttpResponse,
      GoogleGenAI: class {
        chats = {};
        models = {
          embedContent: (_params: { model: string; contents: string }) =>
            new HttpResponse().json(),
        };
      },
    });
    const response = new HttpResponse();
    expect(response.json()).toBe(promise);
    await expect(promise).rejects.toBe(error);
    const client = new wrapped.GoogleGenAI();
    await expect(
      client.models.embedContent({
        model: "gemini-embedding-2",
        contents: "hello",
      }),
    ).rejects.toBe(error);
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      output: { count: 0 },
      error: expect.stringContaining("invalid JSON"),
    });
    expect(spans[0]).not.toHaveProperty("metrics.prompt_tokens");
  });
});
