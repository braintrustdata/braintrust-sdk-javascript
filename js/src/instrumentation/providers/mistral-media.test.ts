import { _exportsForTestingOnly } from "../../logger/testing";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { Attachment, currentSpan, initLogger } from "../../logger/core";
import { configureNode } from "../../node/config";
import { wrapMistral } from "../../wrappers/mistral";
import {
  extractMistralOCRInput,
  extractMistralOCROutput,
  extractMistralTranscriptionInput,
  mistralMediaMetrics,
  traceMistralAudio,
} from "./mistral-media";
import { mistralChannels } from "./mistral-interceptors";
import type {
  MistralSpeechEvent,
  MistralTranscriptionEvent,
} from "../../vendor-sdk-types/mistral";

configureNode();
let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
});
beforeEach(() => {
  vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
  vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "false");
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "false");
  background = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({
    projectName: "tmp-luca-mistral-tests",
    projectId: "test-project-id",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

describe("Mistral media capture", () => {
  it("omits inline documents and images by default, keeps URLs and file IDs", () => {
    const input = extractMistralOCRInput([
      {
        model: "ocr",
        document: { documentUrl: "data:application/pdf;base64,c2VjcmV0" },
      },
    ]);
    expect(JSON.stringify(input)).not.toContain("c2VjcmV0");
    expect(
      extractMistralOCRInput([
        { model: "ocr", document: { fileId: "file-123" } },
      ]).input.content[0],
    ).toMatchObject({ file: { file_data: "file-123" } });
    expect(
      extractMistralOCRInput([
        {
          model: "ocr",
          document: { imageUrl: "https://example.com/image.png" },
        },
      ]).input.content[0],
    ).toMatchObject({ image_url: { url: "https://example.com/image.png" } });
    const result = {
      pages: [
        {
          index: 0,
          markdown: "Document text",
          images: [
            {
              id: "image",
              imageBase64: "c2VjcmV0",
              imageAnnotation: "A figure",
            },
          ],
        },
      ],
      usageInfo: { pagesProcessed: 1 },
    };
    const output = extractMistralOCROutput(result);
    expect(output.annotations.pages[0].images[0]).toMatchObject({
      imageAnnotation: "A figure",
      contentIndex: 0,
    });
    expect(JSON.stringify(output)).not.toContain("c2VjcmV0");
    expect(result.pages[0].images[0].imageBase64).toBe("c2VjcmV0");
  });

  it.each([
    ["true", "false", false],
    ["false", "true", false],
    ["true", "true", true],
    ["1", "1", true],
  ])(
    "requires both audio input controls (%s, %s)",
    (shared, audio, capture) => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", shared);
      vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", audio);
      const input = extractMistralTranscriptionInput([
        {
          model: "transcribe",
          file: { fileName: "audio.wav", content: new Uint8Array([1, 2, 3]) },
        },
      ]);
      expect(input.input.content[0].file.file_data instanceof Attachment).toBe(
        capture,
      );
    },
  );

  it("captures OCR figures without bypassing the audio controls", () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
    const result = {
      pages: [
        {
          index: 0,
          markdown: "A figure",
          images: [
            { id: "figure", imageBase64: "data:image/png;base64,aW1hZ2U=" },
            { id: "audio", imageBase64: "data:audio/wav;base64,YXVkaW8=" },
          ],
        },
      ],
    };
    expect(extractMistralOCROutput(result).content).toMatchObject([
      { image_url: { url: expect.any(Attachment) } },
      { image_url: { url: "<omitted>" } },
    ]);
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
    expect(extractMistralOCROutput(result).content[1]).toMatchObject({
      image_url: { url: expect.any(Attachment) },
    });
    expect(
      extractMistralOCRInput([
        {
          model: "ocr",
          document: { imageUrl: result.pages[0].images[1].imageBase64 },
        },
      ]).input.content[0],
    ).toMatchObject({ image_url: { url: "<omitted>" } });
  });

  it("does not consume an input stream even when capture is enabled", () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
    const stream = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
    const input = extractMistralTranscriptionInput([
      { model: "transcribe", file: { fileName: "audio.wav", content: stream } },
    ]);
    expect(input.input.content[0].file.file_data).toBe("<omitted>");
    expect(stream.locked).toBe(false);
  });

  it("allows only finite nonnegative canonical token metrics", () => {
    expect(
      mistralMediaMetrics({
        promptTokens: 4,
        completionTokens: 0,
        totalTokens: 4,
        promptAudioSeconds: 2,
        arbitrary: 42,
      }),
    ).toEqual({ prompt_tokens: 4, completion_tokens: 0, tokens: 4 });
    expect(
      mistralMediaMetrics({
        promptTokens: NaN,
        totalTokens: Infinity,
        completionTokens: -1,
      }),
    ).toEqual({});
  });

  it("includes reported audio input tokens in the canonical input total", () => {
    expect(
      mistralMediaMetrics({
        promptTokens: 5,
        completionTokens: 8,
        totalTokens: 388,
        prompt_tokens_details: { audio_tokens: 375, cached_tokens: 1 },
      }),
    ).toEqual({
      prompt_tokens: 380,
      completion_tokens: 8,
      tokens: 388,
      prompt_audio_tokens: 375,
      prompt_cached_tokens: 1,
    });
  });

  it("preserves the receiver, options, promise helpers, result, and async context", async () => {
    const response = {
      model: "ocr",
      pages: [{ index: 0, markdown: "hello", images: [] }],
    };
    const options = { timeoutMs: 10 };
    const seen: string[] = [];
    let promise: Promise<typeof response> & { helper?: string };
    const ocr = {
      process(
        request: { model: string; document: { fileId: string } },
        suppliedOptions?: unknown,
      ) {
        expect(this).toBe(ocr);
        expect(suppliedOptions).toBe(options);
        expect(request.document.fileId).toBe("id");
        seen.push(currentSpan().spanId);
        promise = Promise.resolve().then(() => {
          seen.push(currentSpan().spanId);
          return response;
        });
        promise.helper = "preserved";
        return promise;
      },
    };
    const result = wrapMistral({ ocr }).ocr.process(
      { model: "ocr", document: { fileId: "id" } },
      options,
    );
    expect(result).toBe(promise!);
    expect(await result).toBe(response);
    expect(seen[0]).toBeTruthy();
    expect(seen[1]).toBe(seen[0]);
    const rows = await background.drain();
    expect(rows).toHaveLength(1);
  });

  it("preserves rejected promises and logs provider failures", async () => {
    const error = new Error("provider failed");
    const promise = Promise.reject(error);
    expect(
      mistralChannels.transcriptionsComplete.invoke(
        () => promise,
        undefined,
        [{ model: "transcribe" }],
        {},
      ),
    ).toBe(promise);
    await expect(promise).rejects.toBe(error);
    expect(JSON.stringify(await background.drain())).toContain(
      "provider failed",
    );
  });

  it("aggregates transcription text, segments, usage and producer context", async () => {
    const ids: string[] = [];
    async function* events(): AsyncGenerator<MistralTranscriptionEvent> {
      ids.push(currentSpan().spanId);
      yield { data: { type: "transcription.language", language: "en" } };
      await Promise.resolve();
      ids.push(currentSpan().spanId);
      yield { data: { type: "transcription.text.delta", text: "Hello" } };
      yield {
        data: {
          type: "transcription.done",
          text: "Hello",
          language: "en",
          model: "resolved",
          usage: {
            promptAudioSeconds: 1,
            promptTokens: 3,
            completionTokens: 1,
            totalTokens: 4,
          },
          segments: [
            { text: "Hello", start: 0, end: 1, speakerId: "speaker_0" },
          ],
        },
      };
    }
    const stream = events();
    const result = await mistralChannels.transcriptionsStream.invoke(
      async () => stream,
      undefined,
      [{ model: "transcribe" }],
      {},
    );
    expect(result).toBe(stream);
    for await (const _event of result) {
      /* consume */
    }
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    const rows = await background.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      output: {
        content: [{ type: "text", text: "Hello" }],
        annotations: { duration: 1, segments: [{ speakerId: "speaker_0" }] },
      },
      metadata: { model: "resolved" },
      metrics: {
        prompt_tokens: 3,
        completion_tokens: 1,
        tokens: 4,
        time_to_first_token: expect.any(Number),
      },
    });
  });

  it.each([
    ["true", "false", false],
    ["false", "true", false],
    ["true", "true", true],
  ])(
    "requires both speech output controls (%s, %s)",
    async (shared, agent, capture) => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", shared);
      vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", agent);
      const response = { audioData: btoa("audio") };
      const output = await mistralChannels.speechComplete.invoke(
        async () => response,
        undefined,
        [{ input: "hello", model: "tts", responseFormat: "mp3" }],
        {},
      );
      expect(output).toBe(response);
      const rows = await background.drain();
      expect(JSON.stringify(rows)).not.toContain(response.audioData);
      expect(JSON.stringify(rows)).toContain(
        capture ? "braintrust_attachment" : "<omitted>",
      );
    },
  );

  it("segments PCM at sample boundaries and keeps stream and event identity", async () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
    const chunks: MistralSpeechEvent[] = [
      { data: { type: "speech.audio.delta", audioData: btoa("12345") } },
      { data: { type: "speech.audio.delta", audioData: btoa("678901234567") } },
      { data: { type: "speech.audio.done", usage: { totalTokens: 3 } } },
    ];
    const stream = (async function* () {
      yield* chunks;
    })();
    const promise = Promise.resolve(stream);
    expect(
      traceMistralAudio(
        () => promise,
        {
          arguments: [{ input: "hello", model: "tts", responseFormat: "pcm" }],
          self: undefined,
        },
        8,
      ),
    ).toBe(promise);
    const result = await promise;
    const received = [];
    for await (const chunk of result) received.push(chunk);
    expect(received).toEqual(chunks);
    expect(received[0]).toBe(chunks[0]);
    const rows = await background.drain();
    expect(rows[0]).toMatchObject({
      output: {
        content: [{ file: { byte_size: 8 } }, { file: { byte_size: 8 } }],
        annotations: { segments: [{ byte_offset: 0 }, { byte_offset: 8 }] },
      },
    });
  });

  it("does not upload partial encoded speech when a consumer cancels", async () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
    let closed = false;
    const stream = (async function* () {
      try {
        yield {
          data: { type: "speech.audio.delta", audioData: btoa("partial") },
        };
        yield { data: { type: "speech.audio.done" } };
      } finally {
        closed = true;
      }
    })();
    const result = await mistralChannels.speechComplete.invoke(
      async () => stream,
      undefined,
      [{ input: "hello", model: "tts", stream: true }],
      {},
    );
    for await (const _chunk of result as AsyncIterable<MistralSpeechEvent>)
      break;
    expect(closed).toBe(true);
    const rows = await background.drain();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("braintrust_attachment");
    expect(rows[0]).toMatchObject({ metrics: { end: expect.any(Number) } });
  });
  it("leaves job, voice management, and realtime resources untouched", async () => {
    const voices = { list: vi.fn(async () => []) };
    const sessions = { create: vi.fn(async () => ({ id: "session" })) };
    const jobs = { create: vi.fn(async () => ({ id: "job" })) };
    const source = {
      audio: {
        speech: { complete: async () => ({ audioData: "" }) },
        voices,
        sessions,
      },
      batch: { jobs },
    };
    const wrapped = wrapMistral(source);
    expect(wrapped.audio.voices).toBe(voices);
    expect(wrapped.audio.sessions).toBe(sessions);
    expect(wrapped.batch.jobs).toBe(jobs);
    await wrapped.audio.voices.list();
    await wrapped.audio.sessions.create();
    await wrapped.batch.jobs.create();
    expect(await background.drain()).toHaveLength(0);
  });
});
