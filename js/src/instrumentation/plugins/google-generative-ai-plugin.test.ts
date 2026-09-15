import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Attachment, _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { wrapGoogleGenerativeAI } from "../../wrappers/google-generative-ai";
import { googleGenerativeAIChannels as channels } from "./google-generative-ai-channels";

configureNode();

describe("Google Generative AI instrumentation", () => {
  let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "tmp-luca-google-generative-ai-tests",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("preserves promises, response helpers, options and receivers while excluding credentials", async () => {
    const text = () => "Hello";
    const response = {
      candidates: [{ content: { parts: [{ text: "Hello" }], role: "model" } }],
      text,
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 3,
        totalTokenCount: 15,
        cachedContentTokenCount: 4,
      },
    };
    const promise = Promise.resolve({ response });
    const options = { timeout: 100 };
    const model = {
      model: "models/gemini-test",
      apiKey: "secret",
      generationConfig: { temperature: 0, secret: "not-logged" },
      generateContent: vi.fn(function (
        this: unknown,
        request,
        receivedOptions,
      ) {
        expect(this).toBe(model);
        expect(receivedOptions).toBe(options);
        return promise;
      }),
    };
    const client = { getGenerativeModel: () => model };
    const wrapped = wrapGoogleGenerativeAI(client);
    expect(wrapGoogleGenerativeAI(wrapped)).toBe(wrapped);
    const result = wrapped
      .getGenerativeModel()
      .generateContent("Hello", options);
    expect(result).toBe(promise);
    expect((await result).response.text).toBe(text);
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      input: {
        model: "gemini-test",
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
      metadata: { model: "gemini-test", provider: "google", temperature: 0 },
      metrics: {
        prompt_tokens: 10,
        completion_tokens: 5,
        tokens: 15,
        prompt_cached_tokens: 4,
        completion_reasoning_tokens: 3,
      },
    });
    expect(JSON.stringify(spans)).not.toContain("secret");
  });

  it("does not duplicate spans when a manually wrapped method is also auto instrumented", async () => {
    const model = {
      model: "models/test",
      generateContent(request: string) {
        return channels.generateContent.invoke(
          async () => ({ response: {} }),
          model,
          [request],
          {},
        );
      },
    };
    await wrapGoogleGenerativeAI({ getGenerativeModel: () => model })
      .getGenerativeModel()
      .generateContent("hello");
    expect(await logger.drain()).toHaveLength(1);
  });

  it("preserves provider errors and contains extraction failures", async () => {
    const error = new Error("provider failed");
    const promise = Promise.reject(error);
    const result = channels.generateContent.invoke(
      () => promise,
      { model: "models/test" },
      ["hello"],
      {},
    );
    expect(result).toBe(promise);
    await expect(result).rejects.toBe(error);
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toHaveProperty(
      "error",
      expect.stringContaining("provider failed"),
    );
    const malformed = {
      get model() {
        throw new Error("bad getter");
      },
    };
    const target = vi.fn(async () => ({ response: {} }));
    await channels.generateContent.invoke(target, malformed, ["hello"], {});
    expect(target).toHaveBeenCalledOnce();
    expect(await logger.drain()).toHaveLength(0);
  });

  it("captures embeddings without vectors or fabricated token usage", async () => {
    await channels.batchEmbedContents.invoke(
      async () => ({ embeddings: [{ values: [0.1] }, { values: [0.2] }] }),
      { model: "models/embedding" },
      [
        {
          requests: ["one", "two"].map((text) => ({
            content: { parts: [{ text }] },
            outputDimensionality: 1,
          })),
        },
      ],
      {},
    );
    const spans = await logger.drain();
    expect(spans[0]).toMatchObject({
      input: {
        inputs: [{ content: "one" }, { content: "two" }],
        output_dimensions: 1,
      },
      output: { count: 2 },
    });
    expect(spans[0]).not.toHaveProperty("metrics." + "completion_tokens");
    expect(spans[0]).not.toHaveProperty("metrics." + "prompt_tokens");
  });

  it.each([0, 3])(
    "captures reported embedding usage of %s tokens",
    async (promptTokenCount) => {
      await channels.embedContent.invoke(
        async () => ({
          embedding: { values: [0.1] },
          usageMetadata: { promptTokenCount },
        }),
        { model: "models/embedding" },
        ["hello"],
        {},
      );
      const spans = await logger.drain();
      expect(spans[0]).toMatchObject({
        output: { count: 1 },
        metrics: { prompt_tokens: promptTokenCount, tokens: promptTokenCount },
      });
      expect(spans[0]).not.toHaveProperty("metrics.completion_tokens");
    },
  );

  it("captures batch embedding usage once, including audio input tokens", async () => {
    await channels.batchEmbedContents.invoke(
      async () => ({
        embeddings: [{ values: [0.1] }, { values: [0.2] }],
        usageMetadata: {
          promptTokenCount: 12,
          promptTokenDetails: [
            { modality: "TEXT", tokenCount: 2 },
            { modality: "AUDIO", tokenCount: 6 },
            { modality: "AUDIO", tokenCount: 4 },
          ],
        },
      }),
      { model: "models/embedding" },
      [
        {
          requests: [
            { content: { parts: [{ text: "one" }] } },
            { content: { parts: [{ text: "two" }] } },
          ],
        },
      ],
      {},
    );
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      output: { count: 2 },
      metrics: { prompt_tokens: 12, tokens: 12, prompt_audio_tokens: 10 },
    });
    expect(spans[0]).not.toHaveProperty("metrics.completion_tokens");
  });

  it.each([-1, NaN, Infinity])(
    "omits invalid embedding usage %s",
    async (promptTokenCount) => {
      await channels.embedContent.invoke(
        async () => ({
          embedding: { values: [0.1] },
          usageMetadata: {
            promptTokenCount,
            promptTokenDetails: [
              { modality: "AUDIO", tokenCount: promptTokenCount },
            ],
          },
        }),
        { model: "models/embedding" },
        ["hello"],
        {},
      );
      const spans = await logger.drain();
      expect(spans[0]).not.toHaveProperty("metrics.prompt_tokens");
      expect(spans[0]).not.toHaveProperty("metrics.tokens");
      expect(spans[0]).not.toHaveProperty("metrics.prompt_audio_tokens");
    },
  );

  it("finishes response-only streams and preserves their aggregate and iterator identities", async () => {
    const response = Promise.resolve({
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
    });
    const stream = (async function* () {
      yield { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
    })();
    const value = { response, stream };
    const result = await channels.generateContentStream.invoke(
      async () => value,
      { model: "models/test" },
      ["hello"],
      {},
    );
    expect(result).toBe(value);
    expect(result.response).toBe(response);
    expect(result.stream).toBe(stream);
    await response;
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toHaveProperty(
      "output.candidates.0.content.parts.0.text",
      "hello",
    );
    expect(spans[0]).not.toHaveProperty("metrics." + "time_to_first_token");
  });

  it("logs stream failures and propagates the original error", async () => {
    const error = new Error("stream failed");
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<never>((_, reject) => {
      rejectResponse = reject;
    });
    const stream = (async function* () {
      yield { candidates: [{ content: { parts: [{ text: "partial" }] } }] };
      rejectResponse(error);
      throw error;
    })();
    const result = await channels.generateContentStream.invoke(
      async () => ({ response, stream }),
      { model: "models/test" },
      ["hello"],
      {},
    );
    await expect(async () => {
      for await (const chunk of result.stream) expect(chunk).toBeDefined();
    }).rejects.toBe(error);
    await expect(response).rejects.toBe(error);
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toHaveProperty(
      "error",
      expect.stringContaining("stream failed"),
    );
    expect(spans[0]).toHaveProperty("metrics.time_to_first_token");
  });
  it("captures partial output on cancellation without consuming the rest of the stream", async () => {
    const cleanup = vi.fn();
    const stream = (async function* () {
      try {
        yield { candidates: [{ content: { parts: [{ text: "first" }] } }] };
        throw new Error("must not advance");
      } finally {
        cleanup();
      }
    })();
    const response = new Promise<never>(() => {});
    const result = await channels.generateContentStream.invoke(
      async () => ({ response, stream }),
      { model: "models/test" },
      ["hello"],
      {},
    );
    for await (const chunk of result.stream) {
      expect(chunk).toBeDefined();
      break;
    }
    expect(cleanup).toHaveBeenCalledOnce();
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toHaveProperty(
      "output.candidates.0.content.parts.0.text",
      "first",
    );
    expect(spans[0]).toHaveProperty("metrics.end");
  });

  it("captures function responses and system instructions without mutating chat history", async () => {
    const history = [{ role: "user", parts: [{ text: "weather?" }] }];
    const chat = {
      model: "models/test",
      _history: history,
      _sendPromise: Promise.resolve(),
      params: { systemInstruction: "Be concise" },
    };
    const request = [
      { functionResponse: { name: "weather", response: { sunny: true } } },
    ];
    await channels.sendMessage.invoke(
      async () => ({ response: {} }),
      chat,
      [request],
      {},
    );
    expect(history).toHaveLength(1);
    const spans = await logger.drain();
    expect(spans[0]).toHaveProperty("input.contents", [
      { role: "system", parts: [{ text: "Be concise" }] },
      ...history,
      { role: "function", parts: request },
    ]);
  });
  it("keeps multiple embedding text parts in one ordered input", async () => {
    await channels.embedContent.invoke(
      async () => ({ embedding: { values: [0.1] } }),
      { model: "models/test" },
      [["one", "two"]],
      {},
    );
    const spans = await logger.drain();
    expect(spans[0]).toHaveProperty("input.inputs", [
      {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    ]);
  });

  it("converts image inputs without mutating the provider request", async () => {
    const inlineData = { data: "aGVsbG8=", mimeType: "image/png" };
    const request = [{ inlineData }];
    await channels.generateContent.invoke(
      async () => ({ response: {} }),
      { model: "models/test" },
      [request],
      {},
    );
    const spans = await logger.drain();
    expect(spans[0]).toHaveProperty(
      "input.contents.0.parts.0.inlineData.data",
      expect.any(Attachment),
    );
    expect(request[0].inlineData).toBe(inlineData);
    expect(inlineData.data).toBe("aGVsbG8=");
  });

  it("keeps all original input when any attachment cannot be converted", async () => {
    const request = [
      { inlineData: { data: "aGVsbG8=", mimeType: "image/png" } },
      { inlineData: { data: "invalid-base64!", mimeType: "image/png" } },
    ];
    await channels.generateContent.invoke(
      async () => ({ response: {} }),
      { model: "models/test" },
      [request],
      {},
    );
    const spans = await logger.drain();
    expect(spans[0]).toHaveProperty("input.contents.0.parts", request);
  });
  it("does not count empty text chunks as the first token", async () => {
    const stream = (async function* () {
      yield { candidates: [{ content: { parts: [{ text: "" }] } }] };
    })();
    const response = new Promise<never>(() => {});
    const result = await channels.generateContentStream.invoke(
      async () => ({ response, stream }),
      { model: "models/test" },
      ["hello"],
      {},
    );
    const iterator = result.stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    const spans = await logger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).not.toHaveProperty("metrics.time_to_first_token");
  });
});
