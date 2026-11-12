import { expect, test, vi } from "vite-plus/test";
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

async function collectFinalValue(
  chunks: (string | Uint8Array | BraintrustStreamChunk)[],
) {
  const final = vi.fn();
  const error = vi.fn();
  const emitted: BraintrustStreamChunk[] = [];
  const input = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  await input
    .pipeThrough(createFinalValuePassThroughStream(final, error))
    .pipeTo(
      new WritableStream({
        write(chunk) {
          emitted.push(chunk);
        },
      }),
    );
  return { final, error, emitted };
}

test.each(["é", "€", "🧠", "Пам’ять 🧠 漢字"])(
  "final value and forwarded text preserve every UTF-8 split: %s",
  async (text) => {
    const bytes = new TextEncoder().encode(text);
    for (let split = 1; split < bytes.length; split++) {
      const { final, error, emitted } = await collectFinalValue([
        bytes.subarray(0, split),
        new Uint8Array(),
        bytes.subarray(split),
      ]);
      expect(final).toHaveBeenCalledExactlyOnceWith(text);
      expect(error).not.toHaveBeenCalled();
      expect(emitted.map((chunk) => chunk.data).join("")).toBe(text);
    }
  },
);

test.each([
  { chunks: [Uint8Array.of(0xf0, 0x9f)], expected: "�" },
  { chunks: [Uint8Array.of(0xf0), Uint8Array.of(0x9f)], expected: "�" },
  {
    chunks: [
      Uint8Array.of(0xc3),
      { type: "text_delta", data: "middle" } as const,
      Uint8Array.of(0xa9),
    ],
    expected: "�middle�",
  },
])(
  "final value replaces incomplete byte runs: $expected",
  async ({ chunks, expected }) => {
    const { final, emitted } = await collectFinalValue(chunks);
    expect(final).toHaveBeenCalledExactlyOnceWith(expected);
    expect(emitted.map((chunk) => chunk.data).join("")).toBe(expected);
  },
);
