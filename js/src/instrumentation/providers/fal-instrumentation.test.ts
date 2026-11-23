import { registerInstrumentation } from "../registrations/fal";
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
import { wrapFal } from "../../wrappers/fal";
import { falChannels } from "./fal-interceptors";

configureNode();
registerInstrumentation();

describe("fal model execution", () => {
  let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "tmp-luca",
      projectId: "test-project-id",
      autoCaptureAttachments: false,
    });
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "false");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("keeps promises, results, arguments, receivers and one span across repeated wrapping", async () => {
    const input = {
      prompt: "A small bird",
      image_url: "https://example.com/image.png",
    };
    const options = { input };
    const result = {
      data: { images: [{ url: "https://example.com/result.png", width: 32 }] },
      requestId: "request",
    };
    const promise = Object.assign(Promise.resolve(result), { helper: true });
    const queue = { submit: vi.fn() };
    const raw = {
      queue,
      realtime: {},
      storage: {},
      streaming: { stream: vi.fn() },
      stream: vi.fn(),
      run: vi.fn(function (this: unknown, _model: string, options: unknown) {
        expect(this).toBe(raw);
        expect(options).toEqual({ input });
        return promise;
      }),
    };
    const wrapped = wrapFal(raw);
    expect(wrapFal(wrapped)).toBe(wrapped);
    expect(wrapFal(raw)).toBe(wrapped);
    expect(wrapped.queue).toBe(queue);
    expect(wrapped.realtime).toBe(raw.realtime);
    expect(wrapped.storage).toBe(raw.storage);
    expect(wrapped.run("model", options)).toBe(promise);
    expect(await promise).toBe(result);
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.filter((row) => row.span_attributes?.name)).toHaveLength(1);
    expect(rows.find((row) => row.output)?.output).toEqual({
      content: [
        {
          type: "image_url",
          image_url: { url: "https://example.com/result.png", width: 32 },
        },
      ],
    });
    expect(rows.some((row) => row.metadata?.request_id === "request")).toBe(
      true,
    );
  });

  it("leaves subscribe and the complete queue lifecycle uninstrumented", async () => {
    const parent = currentSpan();
    const result = { data: { images: [] }, requestId: "request" };
    const queue = {
      submit: vi.fn(async () => ({ request_id: "request" })),
      status: vi.fn(async () => ({ status: "COMPLETED" })),
      subscribeToStatus: vi.fn(async () => ({ status: "COMPLETED" })),
      result: vi.fn(async () => result),
      cancel: vi.fn(async () => undefined),
    };
    const onEnqueue = vi.fn(() => expect(currentSpan()).toBe(parent));
    const raw = {
      run: vi.fn(),
      stream: vi.fn(),
      streaming: { stream: vi.fn() },
      queue,
      subscribe: async (
        _model: string,
        options: { onEnqueue: (id: string) => void },
      ) => {
        const { request_id } = await queue.submit();
        options.onEnqueue(request_id);
        await queue.subscribeToStatus();
        return queue.result();
      },
    };
    const wrapped = wrapFal(wrapFal(raw));
    expect(wrapped.subscribe).toBe(raw.subscribe);
    expect(wrapped.queue).toBe(queue);
    expect(await wrapped.subscribe("fal-ai/model", { onEnqueue })).toBe(result);
    expect(onEnqueue).toHaveBeenCalledWith("request");
    await wrapped.queue.submit();
    await wrapped.queue.status();
    await wrapped.queue.subscribeToStatus();
    expect(await wrapped.queue.result()).toBe(result);
    await wrapped.queue.cancel();
    expect(await logger.drain()).toEqual([]);
    const error = new Error("queue failed");
    queue.submit.mockRejectedValueOnce(error);
    await expect(wrapped.subscribe("fal-ai/model", { onEnqueue })).rejects.toBe(
      error,
    );
    expect(await logger.drain()).toEqual([]);
  });

  it("preserves context across awaits and restores the caller context", async () => {
    const parent = currentSpan();
    let active: unknown;
    await falChannels.run.invoke(
      async () => {
        active = currentSpan();
        await Promise.resolve();
        expect(currentSpan()).toBe(active);
        expect(active).not.toBe(parent);
        return {
          data: { audio: { url: "https://example.com/speech.wav" } },
          requestId: "r",
        };
      },
      undefined,
      ["fal-ai/kokoro/american-english", { input: { prompt: "Hello" } }],
      {},
    );
    expect(currentSpan()).toBe(parent);
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.find((row) => row.metadata?.model)?.metadata).toMatchObject({
      provider: "fal",
      model: "fal-ai/kokoro/american-english",
    });
  });

  it.each([false, true])(
    "preserves synchronous=%s failures and ends spans",
    async (sync) => {
      const error = new Error("model failed");
      const invoke = () =>
        falChannels.run.invoke(
          () => {
            if (sync) throw error;
            return Promise.reject(error);
          },
          undefined,
          ["fal-ai/model"],
          {},
        );
      if (sync) expect(invoke).toThrow(error);
      else await expect(invoke()).rejects.toBe(error);
      const rows = (await logger.drain()) as Record<string, any>[];
      expect(rows.some((row) => row.error)).toBe(true);
      expect(rows.filter((row) => row.metrics?.end)).toHaveLength(1);
    },
  );

  it.each([
    [false, false, false],
    [true, false, false],
    [true, true, false],
    [true, false, true],
    [true, true, true],
  ])(
    "gates inline media separately (shared=%s user=%s agent=%s)",
    async (shared, user, agent) => {
      initLogger({
        projectName: "tmp-luca",
        projectId: "test-project-id",
        autoCaptureAttachments: shared,
      });
      vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", String(user));
      vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", String(agent));
      const input = {
        image_url: "data:image/png;base64,AQID",
        audio_url: "data:audio/wav;base64,AQID",
        video_url: "data:video/mp4;base64,AQID",
        bytes: new Uint8Array([1, 2]),
        remote: "https://example.com/video.mp4",
      };
      await falChannels.run.invoke(
        async () => ({
          data: {
            images: [input.image_url],
            audio: input.audio_url,
            video: input.video_url,
          },
          requestId: "r",
        }),
        undefined,
        ["fal-ai/model", { input }],
        {},
      );
      const rows = (await logger.drain()) as Record<string, any>[];
      for (const [payload, recording] of [
        [rows.find((row) => row.input)?.input, user],
        [rows.find((row) => row.output)?.output, agent],
      ] as const) {
        expect(payload.content[0].image_url.url instanceof Attachment).toBe(
          shared,
        );
        expect(payload.content[1].file.file_data instanceof Attachment).toBe(
          shared && recording,
        );
        expect(payload.content[2].file.file_data instanceof Attachment).toBe(
          shared && recording,
        );
        if (!(shared && recording))
          expect(payload.content[2].file.file_data).toBe("<omitted>");
        expect(payload).not.toHaveProperty("bytes");
      }
      expect(input.audio_url).toBe("data:audio/wav;base64,AQID");
    },
  );

  it.each(["batch", "realtime", "live", "requests", "queue"])(
    "does not trace %s endpoints",
    async (kind) => {
      await falChannels.run.invoke(
        async () => ({ data: {}, requestId: "r" }),
        undefined,
        [`fal-ai/model/${kind}`],
        {},
      );
      expect(await logger.drain()).toEqual([]);
    },
  );

  it.each([
    { subdomain: "queue" },
    { path: "/requests/id/status" },
    { url: "https://queue.fal.run/fal-ai/model" },
    { method: "GET" },
  ])("does not trace lifecycle overrides %j", async (options) => {
    await falChannels.run.invoke(
      async () => ({ data: {}, requestId: "r" }),
      undefined,
      ["fal-ai/model", options],
      {},
    );
    expect(await logger.drain()).toEqual([]);
  });

  it("maps ordered media and only allowed generation parameters", async () => {
    const result = {
      data: {
        images: [
          { url: "https://example.com/1.png", width: 256, height: 256 },
          { url: "https://example.com/2.png" },
        ],
        seed: 42,
        has_nsfw_concepts: [false, false],
        private_data: "omit",
      },
      requestId: "request",
    };
    await falChannels.run.invoke(
      async () => result,
      undefined,
      [
        "fal-ai/flux/schnell",
        {
          input: {
            prompt: "A red square",
            num_images: 2,
            image_size: "square",
            seed: 42,
            num_inference_steps: 1,
            arbitrary: "omit",
            headers: { authorization: "omit" },
          },
        },
      ],
      {},
    );
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.find((row) => row.input)?.input).toEqual({
      operation: "generate",
      prompt: "A red square",
      parameters: { n: 2, size: "square", seed: 42 },
    });
    expect(rows.find((row) => row.output)?.output).toEqual({
      content: [
        {
          type: "image_url",
          image_url: {
            url: "https://example.com/1.png",
            width: 256,
            height: 256,
          },
        },
        { type: "image_url", image_url: { url: "https://example.com/2.png" } },
      ],
      annotations: { seed: 42, has_nsfw_concepts: [false, false] },
    });
  });

  it.each(["complete", "abort", "error", "no-consent"])(
    "handles typed binary stream %s without changing chunks",
    async (mode) => {
      initLogger({
        projectName: "tmp-luca",
        projectId: "test-project-id",
        autoCaptureAttachments: true,
      });
      vi.stubEnv(
        "BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS",
        mode === "no-consent" ? "false" : "true",
      );
      const controller = new AbortController();
      let emit!: (data: unknown) => void;
      let resolve!: (output: unknown) => void;
      let reject!: (error: unknown) => void;
      const done = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const stream = {
        on: (_event: "data", callback: (data: unknown) => void) => {
          emit = callback;
        },
        done: () => done,
        signal: controller.signal,
        requestId: "request",
        async *[Symbol.asyncIterator]() {
          yield new Uint8Array([1]);
        },
      };
      await falChannels.stream.invoke(
        async () => stream,
        undefined,
        ["fal-ai/speech", { accept: "audio/wav" }],
        {},
      );
      const bytes = new Uint8Array([99, 1, 2, 3, 99]);
      emit({ status: "generating" });
      expect(
        ((await logger.drain()) as Record<string, any>[]).some(
          (row) => row.metrics?.time_to_first_token !== undefined,
        ),
      ).toBe(false);
      emit(bytes.subarray(1, 4));
      bytes.fill(9);
      if (mode === "abort") controller.abort();
      if (mode === "error") {
        reject(new Error("failed"));
        await expect(done).rejects.toThrow("failed");
      } else {
        resolve(bytes);
        await done;
      }
      const rows = (await logger.drain()) as Record<string, any>[];
      const output = rows.find((row) => row.output)?.output;
      if (mode === "complete") {
        const attachment = output.content[0].file.file_data as Attachment;
        expect(attachment).toBeInstanceOf(Attachment);
        expect(
          new Uint8Array(await (await attachment.data()).arrayBuffer()),
        ).toEqual(new Uint8Array([1, 2, 3]));
      } else expect(output?.content ?? []).toEqual([]);
      expect(bytes).toEqual(new Uint8Array([9, 9, 9, 9, 9]));
      expect(rows.filter((row) => row.metrics?.end)).toHaveLength(1);
    },
  );

  it("does not let input extraction errors change application execution", async () => {
    const input = {
      get image_url() {
        throw new Error("bad getter");
      },
    };
    const result = { data: {}, requestId: "r" };
    const target = vi.fn(async () => result);
    expect(
      await falChannels.run.invoke(target, undefined, ["model", { input }], {}),
    ).toBe(result);
    expect(target).toHaveBeenCalledOnce();
  });

  it.each(["done", "error", "abort", "binary"])(
    "observes finite streams through %s without consuming the iterator",
    async (mode) => {
      const controller = new AbortController();
      let onData: (value: unknown) => void = () => {};
      let resolve!: (output: unknown) => void;
      let reject!: (error: unknown) => void;
      const done = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const iterator = vi.fn(async function* () {
        yield { text: "hello" };
      });
      const stream = {
        on: (_type: "data", listener: (value: unknown) => void) => {
          onData = listener;
        },
        done: () => done,
        signal: controller.signal,
        requestId: "r",
        [Symbol.asyncIterator]: iterator,
      };
      const promise = Promise.resolve(stream);
      expect(
        falChannels.stream.invoke(
          () => promise,
          undefined,
          ["model", { input: { prompt: "hello" } }],
          {},
        ),
      ).toBe(promise);
      expect(await promise).toBe(stream);
      const output = { images: [{ url: "https://example.com/output.png" }] };
      onData(mode === "binary" ? new Uint8Array([1, 2, 3]) : output);
      if (mode === "abort") controller.abort();
      if (mode === "error") {
        const error = new Error("stream failed");
        reject(error);
        await expect(stream.done()).rejects.toBe(error);
      } else {
        resolve(output);
        expect(await stream.done()).toBe(output);
      }
      expect(iterator).not.toHaveBeenCalled();
      const rows = (await logger.drain()) as Record<string, any>[];
      expect(rows.filter((row) => row.metrics?.end)).toHaveLength(1);
      if (mode === "done")
        expect(rows.find((row) => row.output)?.output).toEqual({
          content: [
            { type: "image_url", image_url: { url: output.images[0].url } },
          ],
        });
      if (mode === "binary")
        expect(rows.find((row) => row.output)?.output).toEqual({
          content: [],
          annotations: { byte_size: 3 },
        });
      if (mode === "error") expect(rows.some((row) => row.error)).toBe(true);
    },
  );
});
