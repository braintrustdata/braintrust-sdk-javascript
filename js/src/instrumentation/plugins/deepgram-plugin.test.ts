import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Readable } from "node:stream";
import {
  Attachment,
  _exportsForTestingOnly,
  initLogger,
  currentSpan,
  traced,
} from "../../logger";
import { configureNode } from "../../node/config";
import { deepgramChannels } from "./deepgram-interceptors";
import { wrapDeepgram } from "../../wrappers/deepgram";
import { DeepgramPlugin } from "./deepgram-plugin";

configureNode();
const request = {
  text: "Hello",
  model: "aura-2-thalia-en",
  encoding: "linear16",
  container: "wav",
};
const transcription = {
  metadata: { duration: 0.5, request_id: "request" },
  results: {
    channels: [{ alternatives: [{ transcript: "Hello", words: [] }] }],
  },
};

function binaryResponse(response: Response) {
  return {
    stream: () => response.body,
    arrayBuffer: response.arrayBuffer.bind(response),
    blob: response.blob.bind(response),
  };
}

describe("Deepgram instrumentation", () => {
  let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({ projectName: "tmp-luca", projectId: "test-project-id" });
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it.each(["stream", "arrayBuffer", "blob"] as const)(
    "preserves promise helpers and response identity through %s",
    async (mode) => {
      const response = binaryResponse(new Response(new Uint8Array([1, 2, 3])));
      const promise = Object.assign(Promise.resolve(response), {
        withRawResponse: () =>
          Promise.resolve({ data: response, rawResponse: { status: 200 } }),
      });
      const returned = deepgramChannels.generate.invoke(
        () => promise,
        undefined,
        [request],
        {},
      );
      expect(returned).toBe(promise);
      expect(await returned).toBe(response);
      expect((await returned.withRawResponse()).data).toBe(response);
      if (mode === "stream") {
        const stream = response.stream()!;
        expect(stream.locked).toBe(false);
        const reader = stream.getReader();
        const chunk = await reader.read();
        expect(chunk.value).toEqual(new Uint8Array([1, 2, 3]));
        chunk.value!.fill(9);
        await reader.read();
      } else await response[mode]();
      const rows = (await logger.drain()) as Record<string, any>[];
      const files = rows.flatMap((row) => row.output?.content ?? []);
      expect(files).toHaveLength(1);
      const attachment = files[0].file.file_data as Attachment;
      expect(attachment).toBeInstanceOf(Attachment);
      expect(
        new Uint8Array(await (await attachment.data()).arrayBuffer()),
      ).toEqual(new Uint8Array([1, 2, 3]));
      expect(rows.filter((row) => row.metrics?.end)).toHaveLength(1);
    },
  );

  it.each(["", "false", "0", "yes"])(
    "does not observe audio when the shared flag is %s",
    async (flag) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", flag);
      const body = binaryResponse(new Response(new Uint8Array([1, 2])));
      const stream = vi.spyOn(body, "stream");
      const arrayBuffer = body.arrayBuffer;
      await deepgramChannels.generate.invoke(
        async () => body,
        undefined,
        [request],
        {},
      );
      expect(stream).not.toHaveBeenCalled();
      expect(body.arrayBuffer).toBe(arrayBuffer);
      const rows = (await logger.drain()) as Record<string, any>[];
      expect(rows.some((row) => row.input?.prompt === "Hello")).toBe(true);
      expect(rows.some((row) => row.metrics?.end)).toBe(true);
    },
  );

  it("requires separate direction consent and keeps remote references", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "false");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "false");
    const input = Readable.from([Buffer.from([1, 2])]);
    const iterator = input[Symbol.asyncIterator];
    const body = binaryResponse(new Response(new Uint8Array([1, 2])));
    const stream = vi.spyOn(body, "stream");
    await deepgramChannels.transcribeFile.invoke(
      async () => transcription,
      undefined,
      [input, { model: "nova-3" }],
      {},
    );
    await deepgramChannels.transcribeUrl.invoke(
      async () => transcription,
      undefined,
      [{ url: "https://example.com/audio.wav", model: "nova-3" }],
      {},
    );
    await deepgramChannels.generate.invoke(
      async () => body,
      undefined,
      [request],
      {},
    );
    expect(input[Symbol.asyncIterator]).toBe(iterator);
    expect(input.readableFlowing).toBe(null);
    expect(stream).not.toHaveBeenCalled();
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.flatMap((row) => row.input?.content ?? [])).toEqual([
      {
        type: "file",
        file: { filename: "media", file_data: "https://example.com/audio.wav" },
      },
    ]);
    expect(rows.some((row) => row.output?.content?.[0]?.text === "Hello")).toBe(
      true,
    );
  });

  it.each(["buffer", "blob", "stream"])(
    "captures %s input only as consumed and preserves async context",
    async (kind) => {
      const bytes = new Uint8Array([1, 2, 3]);
      const source =
        kind === "buffer"
          ? bytes
          : kind === "blob"
            ? new Blob([bytes], { type: "audio/wav" })
            : Readable.from([bytes]);
      await traced(
        async (parent) => {
          const result = deepgramChannels.transcribeFile.invoke(
            async (input) => {
              const providerSpan = currentSpan().id;
              expect(providerSpan).not.toBe(parent.id);
              await Promise.resolve();
              expect(currentSpan().id).toBe(providerSpan);
              if (kind === "stream")
                for await (const _ of input as AsyncIterable<Uint8Array>) {
                  /* consume upload */
                }
              return transcription;
            },
            undefined,
            [source, { model: "nova-3" }],
            {},
          );
          expect(await result).toBe(transcription);
          expect(currentSpan().id).toBe(parent.id);
        },
        { name: "parent" },
      );
      bytes.fill(9);
      const rows = (await logger.drain()) as Record<string, any>[];
      const attachment = rows.flatMap((row) => row.input?.content ?? [])[0].file
        .file_data as Attachment;
      expect(
        new Uint8Array(await (await attachment.data()).arrayBuffer()),
      ).toEqual(new Uint8Array([1, 2, 3]));
    },
  );

  it.each(["cancel", "error", "break"])(
    "ends once and omits partial speech on %s",
    async (mode) => {
      const error = new Error("body failed");
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2]));
          else if (mode === "error") controller.error(error);
        },
      });
      const response = binaryResponse(new Response(stream));
      await deepgramChannels.generate.invoke(
        async () => response,
        undefined,
        [request],
        {},
      );
      if (mode === "break") {
        for await (const _ of stream as unknown as AsyncIterable<Uint8Array>)
          break;
      } else {
        const reader = stream.getReader();
        await reader.read();
        if (mode === "cancel") await reader.cancel();
        else await expect(reader.read()).rejects.toBe(error);
      }
      const rows = (await logger.drain()) as Record<string, any>[];
      expect(rows.filter((row) => row.metrics?.end)).toHaveLength(1);
      expect(rows.flatMap((row) => row.output?.content ?? [])).toEqual([]);
      if (mode === "error") expect(rows.some((row) => row.error)).toBe(true);
    },
  );

  it("does not consume unread speech", async () => {
    const pull = vi.fn();
    const stream = new ReadableStream({ pull }, { highWaterMark: 0 });
    const body = {
      stream: () => stream,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
    };
    await deepgramChannels.generate.invoke(
      async () => body,
      undefined,
      [request],
      {},
    );
    expect(pull).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    await stream.cancel();
  });

  it("preserves legacy result envelopes and reports resolved errors", async () => {
    const failure = new Error("bad request");
    const response = { result: null, error: failure };
    const promise = Promise.resolve(response);
    expect(
      deepgramChannels.legacyAnalyzeText.invoke(
        () => promise,
        undefined,
        [{ text: "Hello" }, { sentiment: true }],
        {},
      ),
    ).toBe(promise);
    expect(await promise).toBe(response);
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.some((row) => row.error)).toBe(true);
  });

  it("observes legacy speech without changing its object or body", async () => {
    const body = new Response(new Uint8Array([1, 2])).body!;
    const value = {
      getStream: async () => body,
      getHeaders: async () => new Headers({ "content-type": "audio/wav" }),
    };
    const result = await deepgramChannels.legacySpeak.invoke(
      async () => value,
      undefined,
      [{ text: "Hi" }, request],
      {},
    );
    expect(result).toBe(value);
    expect(await result.getStream()).toBe(body);
    const reader = body.getReader();
    await reader.read();
    await reader.read();
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.flatMap((row) => row.output?.content ?? [])).toHaveLength(1);
  });

  it("excludes callbacks in requests and transport query parameters", async () => {
    for (const args of [
      [
        {
          callback: "https://example.com/callback",
          url: "https://example.com/audio.wav",
        },
      ],
      [
        { url: "https://example.com/audio.wav" },
        { queryParams: { callback: "https://example.com/callback" } },
      ],
    ] as const) {
      await deepgramChannels.transcribeUrl.invoke(
        async () => transcription,
        undefined,
        [...args],
        {},
      );
    }
    await deepgramChannels.generateV2.invoke(
      async () => binaryResponse(new Response()),
      undefined,
      [{ ...request, callback: "https://example.com/callback" }],
      {},
    );
    expect(await logger.drain()).toEqual([]);
  });

  it("preserves receivers, errors, request options and lazy clients; wrapping twice and auto hooks do not duplicate spans", async () => {
    const error = new Error("provider error");
    const options = { queryParams: {} };
    let gets = 0;
    const media = {
      transcribeUrl(this: unknown, arg: unknown, opts: unknown) {
        expect(this).toBe(media);
        expect(arg).toBe(request);
        expect(opts).toBe(options);
        return deepgramChannels.transcribeUrl.invoke(
          async () => {
            throw error;
          },
          this,
          [request, options],
          {},
        );
      },
    };
    const live = () => {};
    const raw = {
      listen: {
        v1: { media },
        get prerecorded() {
          gets++;
          return {
            transcribeFile: async () => ({
              result: transcription,
              error: null,
            }),
          };
        },
        live,
      },
      speak: {},
      read: {},
      manage: {},
    };
    const client = wrapDeepgram(raw);
    expect(wrapDeepgram(client)).toBe(client);
    expect(wrapDeepgram(raw)).toBe(client);
    expect(client.manage).toBe(raw.manage);
    expect(client.listen.live).toBe(live);
    expect(gets).toBe(0);
    expect(client.listen.prerecorded).not.toBe(client.listen.prerecorded);
    expect(gets).toBe(2);
    await expect(
      client.listen.v1.media.transcribeUrl(request, options),
    ).rejects.toBe(error);
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(
      rows.filter(
        (row) =>
          row.span_attributes?.name ===
          "deepgram.listen.v1.media.transcribeUrl",
      ),
    ).toHaveLength(1);
    expect(rows.filter((row) => row.metrics?.end)).toHaveLength(1);
  });

  it.each(["request", "query", "empty-request-query", "query-array"])(
    "excludes callback mode across every v5 operation (%s)",
    async (mode) => {
      const callback = "https://example.com/callback";
      const params = {
        ...request,
        callback: mode === "request" ? callback : "",
        body: { text: "Hi" },
      };
      const options =
        mode === "request"
          ? {}
          : {
              queryParams: {
                callback: mode === "query-array" ? [callback] : callback,
              },
            };
      if (mode === "query") delete (params as { callback?: string }).callback;
      let calls = 0;
      const promise = Promise.resolve(transcription);
      const method = (..._args: unknown[]) => {
        calls++;
        return promise;
      };
      const client = wrapDeepgram({
        listen: {
          v1: { media: { transcribeFile: method, transcribeUrl: method } },
        },
        speak: {
          v1: { audio: { generate: method } },
          v2: { audio: { generate: method } },
        },
        read: { v1: { text: { analyze: method } } },
      });
      expect(
        client.listen.v1.media.transcribeFile(
          new Uint8Array([1]),
          params,
          options,
        ),
      ).toBe(promise);
      expect(client.listen.v1.media.transcribeUrl(params, options)).toBe(
        promise,
      );
      expect(client.speak.v1.audio.generate(params, options)).toBe(promise);
      expect(client.speak.v2.audio.generate(params, options)).toBe(promise);
      expect(client.read.v1.text.analyze(params, options)).toBe(promise);
      await promise;
      expect(calls).toBe(5);
      expect(await logger.drain()).toEqual([]);
    },
  );

  it.each(["options", "endpoint"])(
    "excludes legacy callback overrides through %s",
    async (mode) => {
      const promise = Promise.resolve({ result: transcription, error: null });
      const method = vi.fn((..._args: unknown[]) => promise);
      const client = wrapDeepgram({
        listen: {
          prerecorded: { transcribeFile: method, transcribeUrl: method },
        },
        speak: { request: method },
        read: { analyzeText: method, analyzeUrl: method },
      });
      const options =
        mode === "options" ? { callback: "https://example.com/callback" } : {};
      // A custom endpoint is a transport override in v3/v4. Repeated and encoded
      // query parameters must not bypass the callback exclusion.
      const endpoint =
        mode === "endpoint"
          ? ":version/listen?callback=&%63allback=https%3A%2F%2Fexample.com%2Fcallback"
          : undefined;
      for (const fn of [
        client.listen.prerecorded.transcribeFile,
        client.listen.prerecorded.transcribeUrl,
        client.speak.request,
        client.read.analyzeText,
        client.read.analyzeUrl,
      ]) {
        expect(fn({ text: "Hi" }, options, endpoint)).toBe(promise);
      }
      await promise;
      expect(method).toHaveBeenCalledTimes(5);
      expect(await logger.drain()).toEqual([]);
    },
  );

  it("leaves all legacy callback methods untouched", async () => {
    const method = vi.fn(async (..._args: unknown[]) => ({
      result: { request_id: "pending" },
      error: null,
    }));
    const raw = {
      listen: {
        prerecorded: {
          transcribeFileCallback: method,
          transcribeUrlCallback: method,
        },
      },
      read: { analyzeTextCallback: method, analyzeUrlCallback: method },
      speak: {},
    };
    const client = wrapDeepgram(raw);
    const callback = new URL("https://example.com/callback");
    for (const fn of [
      client.listen.prerecorded.transcribeFileCallback,
      client.listen.prerecorded.transcribeUrlCallback,
      client.read.analyzeTextCallback,
      client.read.analyzeUrlCallback,
    ]) {
      expect(fn).toBe(method);
      await fn({ text: "Hi" }, callback, { language: "en" });
    }
    expect(method).toHaveBeenCalledTimes(4);
    expect(await logger.drain()).toEqual([]);
  });

  it("uses response MIME type and filename before requested format", async () => {
    const response = binaryResponse(new Response(new Uint8Array([1, 2, 3])));
    const headers = new Headers({
      "content-type": "audio/mpeg",
      "content-disposition": 'attachment; filename="provider.mp3"',
      "dg-model-name": "resolved-voice",
      "dg-request-id": "speech-id",
    });
    const promise = Object.assign(Promise.resolve(response), {
      withRawResponse: () =>
        Promise.resolve({ data: response, rawResponse: { headers } }),
    });
    await deepgramChannels.generate.invoke(
      () => promise,
      undefined,
      [request],
      {},
    );
    await response.arrayBuffer();
    const rows = (await logger.drain()) as Record<string, any>[];
    const part = rows.flatMap((row) => row.output?.content ?? [])[0];
    expect(part.file.filename).toBe("provider.mp3");
    expect(part.file.file_data.reference.content_type).toBe("audio/mpeg");
    expect(rows.some((row) => row.metadata?.model === "resolved-voice")).toBe(
      true,
    );
  });

  it("captures text analysis and reported usage without copying arbitrary metadata", async () => {
    const response = {
      metadata: {
        request_id: "read-id",
        private_field: "must not log",
        sentiment_info: {
          model_uuid: "sentiment-model",
          input_tokens: 5,
          output_tokens: 2,
        },
        topics_info: {
          model_uuid: "topic-model",
          input_tokens: 5,
          output_tokens: 0,
        },
      },
      results: {
        sentiments: { average: { sentiment: "positive" } },
        topics: { segments: [] },
        private_field: "must not log",
      },
    };
    await deepgramChannels.analyze.invoke(
      async () => response,
      undefined,
      [{ body: { text: "I am happy" }, sentiment: true, topics: true }],
      {},
    );
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.find((row) => row.output)?.output).toMatchObject({
      content: [],
      annotations: {
        sentiments: response.results.sentiments,
        topics: response.results.topics,
      },
    });
    expect(
      rows.some(
        (row) =>
          row.metrics?.prompt_tokens === 10 &&
          row.metrics?.completion_tokens === 2 &&
          row.metrics?.tokens === 12,
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("must not log");
  });

  it("omits inline URLs when audio capture is disabled", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "false");
    await deepgramChannels.transcribeUrl.invoke(
      async () => transcription,
      undefined,
      [{ url: "data:audio/wav;base64,AQID" }],
      {},
    );
    const rows = await logger.drain();
    expect(JSON.stringify(rows)).not.toContain("AQID");
  });

  it("keeps synchronous throws and plugin setup/teardown idempotent", async () => {
    const plugin = new DeepgramPlugin();
    plugin.enable();
    plugin.enable();
    plugin.disable();
    plugin.disable();
    const error = new Error("sync failure");
    expect(() =>
      deepgramChannels.analyze.invoke(
        () => {
          throw error;
        },
        undefined,
        [{ body: { text: "Hi" } }],
        {},
      ),
    ).toThrow(error);
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.filter((row) => row.metrics?.end)).toHaveLength(1);
  });
});
