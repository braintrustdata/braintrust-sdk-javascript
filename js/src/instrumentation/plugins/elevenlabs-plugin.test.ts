import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  ReadableStream,
  WritableStream,
  TransformStream,
} from "node:stream/web";
import { Attachment, _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { elevenLabsChannels } from "./elevenlabs-channels";
import { wrapElevenLabs } from "../../wrappers/elevenlabs";

configureNode();
const request = { text: "Hello", modelId: "eleven_flash_v2_5" };

describe("ElevenLabs instrumentation", () => {
  let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "tmp-luca-elevenlabs-unit",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("keeps promise helpers and stream identity, and copies bytes before the caller can mutate them", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(1, 3));
        controller.close();
      },
    });
    const promise = Object.assign(Promise.resolve(stream), {
      withRawResponse: () =>
        Promise.resolve({
          data: stream,
          rawResponse: {
            headers: new Headers({ "content-type": "audio/mpeg" }),
          },
        }),
    });
    const result = elevenLabsChannels.convert.invoke(
      () => promise,
      undefined,
      ["voice", request],
      {},
    );
    expect(result).toBe(promise);
    expect((await result.withRawResponse()).data).toBe(stream);
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    bytes.fill(9);
    await reader.read();
    const spans = (await logger.drain()) as Record<string, any>[];
    const output = spans.find((row: any) => row.output)?.output as any;
    const attachment = output.content[0].file.file_data as Attachment;
    expect(attachment).toBeInstanceOf(Attachment);
    expect(output.content[0].file.byte_size).toBe(2);
    expect(
      new Uint8Array(await (await attachment.data()).arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2]));
  });

  it.each(["cancel", "error", "break"])(
    "omits partial audio on %s",
    async (mode) => {
      const failure = new Error("audio failed");
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
          else if (mode === "error") controller.error(failure);
        },
      });
      const returned = await elevenLabsChannels.stream.invoke(
        async () => stream,
        undefined,
        ["voice", request],
        {},
      );
      if (mode === "break") {
        for await (const _chunk of returned as AsyncIterable<Uint8Array>) break;
      } else {
        const reader = stream.getReader();
        await reader.read();
        if (mode === "cancel") await reader.cancel();
        else await expect(reader.read()).rejects.toBe(failure);
      }
      const rows = (await logger.drain()) as Record<string, any>[];
      expect(rows.some((row: any) => row.metrics?.end)).toBe(true);
      expect(rows.some((row: any) => row.output?.content?.length)).toBe(false);
      if (mode === "error")
        expect(rows.some((row: any) => row.error)).toBe(true);
    },
  );

  it("does not consume unread audio", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++;
        },
      },
      { highWaterMark: 0 },
    );
    await elevenLabsChannels.convert.invoke(
      async () => stream,
      undefined,
      ["voice", request],
      {},
    );
    expect(pulls).toBe(0);
    expect(stream.locked).toBe(false);
    await stream.cancel();
  });

  it("observes Node readable streams without starting flow", async () => {
    const stream = Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
    const result = await elevenLabsChannels.stream.invoke(
      async () => stream,
      undefined,
      ["voice", request],
      {},
    );
    expect(result).toBe(stream);
    expect(stream.readableFlowing).toBe(null);
    const chunks = [];
    for await (const chunk of stream) chunks.push(...chunk);
    expect(chunks).toEqual([1, 2, 3]);
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.find((row: any) => row.output)?.output).toMatchObject({
      content: [{ file: { byte_size: 3 } }],
    });
  });

  it("preserves synchronous errors, receiver, options and repeated wrapping", () => {
    const error = new Error("provider error");
    const options = { abortSignal: new AbortController().signal };
    const sdk = {
      textToSpeech: {
        convert(this: unknown, voice: string, params: unknown, opts: unknown) {
          expect(this).toBe(sdk.textToSpeech);
          expect(voice).toBe("voice");
          expect(params).toBe(request);
          expect(opts).toBe(options);
          throw error;
        },
      },
      speechToText: {},
    };
    const client = wrapElevenLabs(sdk);
    expect(wrapElevenLabs(client)).toBe(client);
    expect(() =>
      client.textToSpeech.convert("voice", request, options),
    ).toThrow(error);
  });

  it.each([true, false, undefined])(
    "only traces request/response transcription (webhook=%s)",
    async (webhook) => {
      const response = { text: "Hello" };
      const promise = Object.assign(Promise.resolve(response), {
        withRawResponse: () => Promise.resolve({ data: response }),
      });
      const params = { modelId: "scribe_v2", webhook };
      const options = { maxRetries: 0 };
      const sdk = {
        textToSpeech: { convert() {} },
        speechToText: {
          convert(this: unknown, request: unknown, opts: unknown) {
            expect(this).toBe(sdk.speechToText);
            expect(request).toBe(params);
            expect(opts).toBe(options);
            return promise;
          },
        },
      };
      const result = wrapElevenLabs(sdk).speechToText.convert(params, options);
      expect(result).toBe(promise);
      expect(await result).toBe(response);
      const rows = (await logger.drain()) as Record<string, any>[];
      expect(
        rows.some(
          (row) =>
            row.span_attributes?.name === "elevenlabs.speechToText.convert",
        ),
      ).toBe(!webhook);
    },
  );

  it("copies Node audio before data listeners mutate chunks", async () => {
    const stream = Readable.from([Buffer.from([1, 2, 3])]);
    await elevenLabsChannels.convert.invoke(
      async () => stream,
      undefined,
      ["voice", request],
      {},
    );
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk) => chunk.fill(9));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const rows = (await logger.drain()) as Record<string, any>[];
    const output = rows.find((row: any) => row.output)?.output as any;
    const attachment = output.content[0].file.file_data as Attachment;
    expect(
      new Uint8Array(await (await attachment.data()).arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each(["pipeTo", "pipeThrough", "values"])(
    "captures audio consumed through %s",
    async (mode) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      await elevenLabsChannels.convert.invoke(
        async () => stream,
        undefined,
        ["voice", request],
        {},
      );
      const output: number[] = [];
      const sink = new WritableStream<Uint8Array>({
        write(chunk) {
          output.push(...chunk);
        },
      });
      if (mode === "pipeTo") await stream.pipeTo(sink);
      else if (mode === "pipeThrough")
        await stream.pipeThrough(new TransformStream()).pipeTo(sink);
      else
        for await (const chunk of stream.values({ preventCancel: true }))
          output.push(...chunk);
      expect(output).toEqual([1, 2, 3]);
      const rows = (await logger.drain()) as Record<string, any>[];
      expect(rows.find((row: any) => row.output)?.output).toMatchObject({
        content: [{ file: { byte_size: 3 } }],
      });
    },
  );

  it("preserves preventCancel when ending Web stream iteration early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await elevenLabsChannels.stream.invoke(
      async () => stream,
      undefined,
      ["voice", request],
      {},
    );
    for await (const _chunk of stream.values({ preventCancel: true })) break;
    expect(cancelled).toBe(false);
    expect(stream.locked).toBe(false);
    await stream.cancel();
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows.some((row: any) => row.output?.content?.length)).toBe(false);
  });
});
