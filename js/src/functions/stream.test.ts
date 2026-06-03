import { expect, test } from "vitest";
import {
  BraintrustStream,
  BraintrustStreamChunk,
  createFinalValuePassThroughStream,
} from "./stream";

const cases: {
  chunks: (string | Uint8Array | BraintrustStreamChunk)[];
  expected: string;
}[] = [
  {
    chunks: [
      { type: "text_delta", data: "Hello, " },
      { type: "text_delta", data: "world!" },
    ],
    expected: "Hello, world!",
  },
];

test("final value passthrough", async () => {
  for (const { chunks, expected } of cases) {
    const inputStream = new ReadableStream({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(c);
        }
        controller.close();
      },
    });

    const sinkChunks: BraintrustStreamChunk[] = [];
    const sink = new WritableStream<BraintrustStreamChunk>({
      write(chunk) {
        sinkChunks.push(chunk);
      },
    });

    let finalValue: unknown = null;
    await inputStream
      .pipeThrough(
        createFinalValuePassThroughStream(
          (v) => {
            finalValue = v;
          },
          (e) => {
            console.error("ERROR", e);
          },
        ),
      )
      .pipeTo(sink);

    expect(finalValue).toBe(expected);
    expect(sinkChunks.map((c) => c.data).join("")).toEqual(expected);
  }
});

test("preserves multi-byte UTF-8 characters split across chunk boundaries", async () => {
  // Regression test: btStreamParser previously decoded each Uint8Array chunk
  // without `{ stream: true }`, so a partial UTF-8 sequence at the end of a
  // chunk was flushed as U+FFFD instead of being held until the next chunk.
  const encoder = new TextEncoder();
  const payload = "“Hello, world.”"; // leading “ is U+201C -> bytes E2 80 9C
  const sseBytes = encoder.encode(
    `event: text_delta\ndata: ${JSON.stringify(payload)}\n\n`,
  );

  // Split inside the first multi-byte character: after E2 80, before 9C.
  const quoteStart = sseBytes.indexOf(0xe2);
  const splitAt = quoteStart + 2;

  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseBytes.subarray(0, splitAt));
      controller.enqueue(sseBytes.subarray(splitAt));
      controller.close();
    },
  });

  const stream = new BraintrustStream(inputStream);
  let out = "";
  for await (const chunk of stream) {
    if (chunk.type === "text_delta") out += chunk.data;
  }

  expect(out).toBe(payload);
  expect(out).not.toContain("\uFFFD");
});

test("final value passthrough with abort", async () => {
  const inputStream = new ReadableStream({
    start(controller) {},
  });

  const controller = new AbortController();
  const stream = new BraintrustStream(inputStream, {
    signal: controller.signal,
  });

  controller.abort();

  await expect(stream.finalValue()).rejects.toThrow(
    "This operation was aborted",
  );
});
