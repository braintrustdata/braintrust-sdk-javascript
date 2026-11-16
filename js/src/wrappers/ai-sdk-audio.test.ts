/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _exportsForTestingOnly,
  currentSpan,
  initLogger,
  TestBackgroundLogger,
} from "../logger";
import { configureNode } from "../node/config";
import { wrapAISDK } from "./ai-sdk/ai-sdk";

configureNode();

let backgroundLogger: TestBackgroundLogger;
beforeEach(async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({
    projectName: "ai-sdk-audio.test.ts",
    projectId: "test-project-id",
  });
  vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "");
  vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "");
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

const model = { modelId: "audio-model", provider: "test.audio" };

for (const name of ["generateSpeech", "experimental_generateSpeech"] as const) {
  describe(name, () => {
    test("preserves arguments, receiver, promise, result, and asynchronous context", async () => {
      const audio = {
        mediaType: "audio/mpeg",
        format: "mp3",
        base64: "aGVsbG8=",
      };
      const result = { audio };
      const unrelatedGetter = vi.fn(() => "private");
      const params = {
        get unrelated() {
          return unrelatedGetter();
        },
        model,
        text: "Hello",
        headers: { authorization: "secret" },
        abortSignal: new AbortController().signal,
      };
      let promise: Promise<typeof result>;
      let insideSpan: string;
      const operation = vi.fn(function (this: unknown, actual: typeof params) {
        expect(this).toBe(wrapped);
        expect(actual).toBe(params);
        insideSpan = currentSpan().spanId;
        promise = Promise.resolve().then(() => {
          expect(currentSpan().spanId).toBe(insideSpan);
          return result;
        });
        return promise;
      });
      const wrapped = wrapAISDK({ [name]: operation });
      const parent = currentSpan().spanId;
      const returned = wrapped[name](params);
      expect(returned).toBe(promise!);
      expect(await returned).toBe(result);
      expect(currentSpan().spanId).toBe(parent);
      expect(operation).toHaveBeenCalledOnce();
      expect(unrelatedGetter).not.toHaveBeenCalled();
      const spans = await backgroundLogger.drain();
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        span_attributes: { name: "generateSpeech", type: "llm" },
        input: { operation: "speech", prompt: "Hello" },
        metadata: { model: "audio-model", provider: "test.audio" },
        output: {
          content: [
            {
              type: "file",
              file: { filename: "audio.mp3", file_data: "<omitted>" },
            },
          ],
        },
      });
      expect(JSON.stringify(spans)).not.toContain("secret");
      expect(JSON.stringify(spans)).not.toContain("aGVsbG8=");
    });
  });
}

for (const [shared, direction, capture] of [
  ["", "true", false],
  ["true", "", false],
  ["true", "false", false],
  ["false", "true", false],
  ["true", "true", true],
  ["1", "1", true],
] as const) {
  test(`speech capture requires both flags (${shared}, ${direction})`, async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", shared);
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", direction);
    const bytes = vi.fn(() => new Uint8Array([1, 2, 3]));
    const audio = {
      mediaType: "audio/mpeg",
      get uint8Array() {
        return bytes();
      },
    };
    const wrapped = wrapAISDK({
      generateSpeech: async (_params: unknown) => ({ audio }),
    });
    await wrapped.generateSpeech({ model, text: "Hello" });
    const [span] = (await backgroundLogger.drain()) as any[];
    expect(bytes).toHaveBeenCalledTimes(capture ? 1 : 0);
    if (capture)
      expect(span.output.content[0].file.file_data.reference).toMatchObject({
        type: "braintrust_attachment",
        content_type: "audio/mpeg",
      });
    else expect(span.output.content[0].file.file_data).toBe("<omitted>");
  });
}

for (const name of ["transcribe", "experimental_transcribe"] as const) {
  test(`${name} preserves transcription fields and strips transport data`, async () => {
    const result = {
      text: "Hello",
      language: "en",
      durationInSeconds: 1.25,
      segments: [{ text: "Hello", startSecond: 0, endSecond: 1.25 }],
      words: [{ text: "Hello", startSecond: 0, endSecond: 1.25 }],
      responses: [{ headers: { authorization: "secret" }, body: "private" }],
    };
    const operation = vi.fn(async () => result);
    const wrapped = wrapAISDK({ [name]: operation });
    expect(
      await (wrapped[name] as any)({ model, audio: new Uint8Array([1, 2, 3]) }),
    ).toBe(result);
    const [span] = (await backgroundLogger.drain()) as any[];
    expect(span.output).toEqual({
      content: [{ type: "text", text: "Hello" }],
      annotations: {
        language: "en",
        duration: 1.25,
        segments: result.segments,
        words: result.words,
      },
    });
    expect(span.metrics).not.toHaveProperty("duration_seconds");
    expect(span.input.content[0].file.file_data).toBe("<omitted>");
  });
}

for (const audio of [
  new Uint8Array([1, 2, 3]),
  new Uint8Array([1, 2, 3]).buffer,
  "AQID",
  new URL("data:audio/wav;base64,AQID"),
]) {
  test(`captures transcription input ${audio.constructor.name} only with user consent`, async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
    const operation = vi.fn(
      async (params: { audio: unknown; model: typeof model }) => {
        expect(params.audio).toBe(audio);
        return { text: "Hello", segments: [] };
      },
    );
    const wrapped = wrapAISDK({ transcribe: operation });
    await wrapped.transcribe({ audio, model });
    let spans = (await backgroundLogger.drain()) as any[];
    expect(spans[0].input.content[0].file.file_data).toBe("<omitted>");
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
    await wrapped.transcribe({ audio, model });
    spans = (await backgroundLogger.drain()) as any[];
    expect(spans[0].input.content[0].file.file_data.reference.type).toBe(
      "braintrust_attachment",
    );
  });
}

test("retains remote references without fetching them", async () => {
  const wrapped = wrapAISDK({
    transcribe: async (_params: unknown) => ({ text: "Hello", segments: [] }),
  });
  await wrapped.transcribe({
    model,
    audio: new URL("https://example.com/audio.mp3"),
  });
  const [span] = (await backgroundLogger.drain()) as any[];
  expect(span.input.content[0].file.file_data).toBe(
    "https://example.com/audio.mp3",
  );
});

test("honors span_info and denyOutputPaths", async () => {
  vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
  const bytes = vi.fn(() => new Uint8Array([1, 2, 3]));
  const operation = vi.fn(async (_params: unknown) => ({
    audio: {
      get uint8Array() {
        return bytes();
      },
      mediaType: "audio/mpeg",
    },
  }));
  const wrapped = wrapAISDK(
    { generateSpeech: operation },
    { denyOutputPaths: ["content[].file.file_data"] },
  );
  await wrapped.generateSpeech({
    model,
    text: "Hello",
    span_info: { name: "custom-speech", metadata: { custom: true } },
  });
  expect(operation.mock.calls[0][0]).toEqual({ model, text: "Hello" });
  const [span] = (await backgroundLogger.drain()) as any[];
  expect(span).toMatchObject({
    span_attributes: { name: "custom-speech" },
    metadata: { custom: true },
    output: { content: [{ file: { file_data: "<omitted>" } }] },
  });
});

for (const synchronous of [false, true]) {
  test(`preserves ${synchronous ? "synchronous" : "asynchronous"} errors`, async () => {
    const error = new Error("speech failed");
    const operation = vi.fn((_params: unknown) => {
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    const wrapped = wrapAISDK({ generateSpeech: operation });
    if (synchronous)
      expect(() => wrapped.generateSpeech({ model, text: "Hello" })).toThrow(
        error,
      );
    else
      await expect(
        wrapped.generateSpeech({ model, text: "Hello" }),
      ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    const [span] = (await backgroundLogger.drain()) as any[];
    expect(span.error).toContain("speech failed");
    expect(span.metrics.end).toEqual(expect.any(Number));
  });
}

test("captures v4 mimeType and snapshots only the returned byte range", async () => {
  vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
  const backing = new Uint8Array([9, 1, 2, 3, 9]);
  const audio = { mimeType: "audio/mp3", uint8Array: backing.subarray(1, 4) };
  const wrapped = wrapAISDK({
    experimental_generateSpeech: async (_params: unknown) => ({ audio }),
  });
  const result = await wrapped.experimental_generateSpeech({
    model,
    text: "Hello",
  });
  expect(result.audio).toBe(audio);
  backing.fill(0);
  const [span] = (await backgroundLogger.drain()) as any[];
  const attachment = span.output.content[0].file.file_data;
  expect(attachment.reference.content_type).toBe("audio/mpeg");
  expect(new Uint8Array(await (await attachment.data()).arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});

for (const provider of ["assemblyai", "gladia", "revai", "fal"]) {
  for (const model of [
    { provider: `${provider}.transcription`, modelId: "model" },
    { provider: "gateway", modelId: `${provider}/model` },
    `${provider}/model`,
  ]) {
    for (const name of ["transcribe", "experimental_transcribe"] as const) {
      test(`${name} traces the full awaited operation through ${JSON.stringify(model)}`, async () => {
        const result = { text: "Hello", segments: [] };
        let complete!: () => void;
        const completed = new Promise<void>((resolve) => {
          complete = resolve;
        });
        let promise!: Promise<typeof result>;
        let insideSpan!: string;
        const parent = currentSpan().spanId;
        const operation = vi.fn(function (this: unknown, _params: unknown) {
          expect(this).toBe(wrapped);
          insideSpan = currentSpan().spanId;
          expect(insideSpan).not.toBe(parent);
          promise = completed.then(() => {
            expect(currentSpan().spanId).toBe(insideSpan);
            return result;
          });
          return promise;
        });
        const wrapped = wrapAISDK({ [name]: operation });
        const params = { model, audio: new Uint8Array([1]) };
        expect(wrapped[name](params)).toBe(promise);
        expect(currentSpan().spanId).toBe(parent);
        const pending = await backgroundLogger.drain();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          span_id: insideSpan,
          span_attributes: { name: "transcribe", type: "llm" },
          input: { operation: "transcribe" },
        });
        expect(pending[0]).not.toHaveProperty("metrics.end");
        expect(pending[0]).not.toHaveProperty("output");
        complete();
        expect(await promise).toBe(result);
        expect(currentSpan().spanId).toBe(parent);
        expect(operation).toHaveBeenCalledExactlyOnceWith(params);
        const finished = await backgroundLogger.drain();
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({
          span_id: insideSpan,
          output: { content: [{ type: "text", text: "Hello" }] },
          metrics: { end: expect.any(Number) },
        });
      });

      test(`${name} preserves rejected promises through ${JSON.stringify(model)}`, async () => {
        const error = new Error("transcription failed");
        let promise!: Promise<never>;
        const operation = vi.fn((_params: unknown) => {
          promise = Promise.reject(error);
          return promise;
        });
        const wrapped = wrapAISDK({ [name]: operation });
        const params = { model, audio: new Uint8Array([1]) };
        expect(wrapped[name](params)).toBe(promise);
        await expect(promise).rejects.toBe(error);
        expect(operation).toHaveBeenCalledExactlyOnceWith(params);
        const spans = await backgroundLogger.drain();
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({
          span_attributes: { name: "transcribe", type: "llm" },
          error: expect.stringContaining("transcription failed"),
          metrics: { end: expect.any(Number) },
        });
      });
    }
  }
}

for (const name of ["generateSpeech", "experimental_generateSpeech"] as const) {
  for (const model of [
    { provider: "deepgram.speech", modelId: "aura-2-helena-en" },
    { provider: "gateway", modelId: "deepgram/aura-2-helena-en" },
    "deepgram/aura-2-helena-en",
  ]) {
    test(`${name} does not trace Deepgram callback delivery through ${JSON.stringify(model)}`, async () => {
      const result = { audio: { mediaType: "audio/mpeg" } };
      const parent = currentSpan().spanId;
      const promise = Promise.resolve().then(() => {
        expect(currentSpan().spanId).toBe(parent);
        return result;
      });
      const operation = vi.fn(function (this: unknown, _params: unknown) {
        expect(this).toBe(wrapped);
        expect(currentSpan().spanId).toBe(parent);
        return promise;
      });
      const wrapped = wrapAISDK({ [name]: operation });
      const params = {
        model,
        text: "Hello",
        providerOptions: {
          deepgram: { callback: "https://example.com/callback" },
        },
      };
      expect(wrapped[name](params)).toBe(promise);
      expect(await promise).toBe(result);
      expect(operation).toHaveBeenCalledExactlyOnceWith(params);
      expect(await backgroundLogger.drain()).toHaveLength(0);
    });
  }
}

test("preserves errors when a newer Deepgram adapter rejects speech callback delivery", async () => {
  const error = new Error("providerOptions.deepgram.callback is not supported");
  const promise = Promise.reject(error);
  const operation = vi.fn((_params: unknown) => promise);
  const wrapped = wrapAISDK({ generateSpeech: operation });
  const params = {
    model: { provider: "deepgram.speech", modelId: "aura-2-helena-en" },
    text: "Hello",
    providerOptions: { deepgram: { callback: "https://example.com/callback" } },
  };
  expect(wrapped.generateSpeech(params)).toBe(promise);
  await expect(promise).rejects.toBe(error);
  expect(operation).toHaveBeenCalledExactlyOnceWith(params);
  expect(await backgroundLogger.drain()).toHaveLength(0);
});

test.each([
  { model: { provider: "fal.speech", modelId: "fal-ai/minimax/speech-02-hd" } },
  { model: { provider: "gateway", modelId: "openai/tts-1" } },
  { model: "openai/tts-1" },
  {
    model: { provider: "deepgram.speech", modelId: "aura-2-helena-en" },
    providerOptions: { deepgram: { callback: null, callbackMethod: "POST" } },
  },
])("traces direct speech without a callback: %j", async (options) => {
  const wrapped = wrapAISDK({
    generateSpeech: async (_params: unknown) => ({
      audio: { mediaType: "audio/mpeg" },
    }),
  });
  await wrapped.generateSpeech({ ...options, text: "Hello" });
  const spans = await backgroundLogger.drain();
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({
    span_attributes: { name: "generateSpeech" },
  });
});

test("does not trace Deepgram callback delivery", async () => {
  const operation = vi.fn(async (_params: unknown) => ({
    text: "",
    segments: [],
  }));
  const wrapped = wrapAISDK({ transcribe: operation });
  const params = {
    model: { provider: "deepgram.transcription", modelId: "nova-3" },
    audio: new Uint8Array([1]),
    providerOptions: { deepgram: { callback: "https://example.com/callback" } },
  };
  await wrapped.transcribe(params);
  expect(operation).toHaveBeenCalledExactlyOnceWith(params);
  expect(await backgroundLogger.drain()).toHaveLength(0);
});
