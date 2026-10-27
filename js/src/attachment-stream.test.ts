import {
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";
import {
  ATTACHMENT_STREAM_HOOK,
  AttachmentStreamProcessor,
  type AttachmentStreamHook,
  type AttachmentStreamSource,
  type AttachmentStreamOptions,
} from "./attachment-stream";
import {
  _exportsForTestingOnly as logging,
  initLogger,
  startSpan,
  type InitLoggerOptions,
  type Logger,
  type Span,
} from "./logger";
import { configureNode } from "./node/config";

configureNode();
beforeAll(() => logging.simulateLoginForTests());
beforeEach(() => logging.useTestBackgroundLogger());
afterEach(() => {
  logging.clearTestBackgroundLogger();
  vi.restoreAllMocks();
});

const format = { contentType: "application/octet-stream" };
async function* bytes(...values: number[][]) {
  for (const value of values) yield new Uint8Array(value);
}

test("calls the factory once per stream and drains each file before requesting another", async () => {
  const events: string[] = [];
  const hook = vi.fn(async function* (source: AttachmentStreamSource) {
    expect(source.format).toEqual(format);
    expect(source.targetFileInputBytes).toBe(4);
    let file = 0;
    try {
      for await (const chunk of source.chunks) {
        const index = file++;
        events.push(`file ${index}`);
        yield {
          format,
          chunks: (async function* () {
            yield chunk.subarray(0, 1);
            yield chunk.subarray(1);
            events.push(`drained ${index}`);
          })(),
        };
      }
    } finally {
      events.push("closed");
    }
  });
  const output: number[][] = [];
  for (let i = 0; i < 2; i++) {
    const processor = new AttachmentStreamProcessor(hook, format, 4, () => 100);
    expect(
      await processor.run(bytes([1, 2], [3]), async (_, data) => {
        output.push([...new Uint8Array(await data.arrayBuffer())]);
        events.push("uploaded");
      }),
    ).toBe(true);
    expect(processor.signal.aborted).toBe(false);
    expect(processor.bufferedByteLength).toBe(0);
  }
  expect(hook).toHaveBeenCalledTimes(2);
  expect(output).toEqual([[1, 2], [3], [1, 2], [3]]);
  expect(events.slice(0, 7)).toEqual([
    "file 0",
    "drained 0",
    "uploaded",
    "file 1",
    "drained 1",
    "uploaded",
    "closed",
  ]);
});

test("permits output before all input is available and a file larger than the target", async () => {
  let consumed = 0;
  const processor = new AttachmentStreamProcessor(
    async function* ({ chunks }) {
      yield {
        format: { contentType: "image/png" },
        chunks: (async function* () {
          yield new Uint8Array([137, 80]);
          for await (const chunk of chunks) {
            consumed++;
            yield chunk;
          }
        })(),
      };
    },
    format,
    1,
    () => 100,
  );
  const uploaded = vi.fn(async (_, data: Blob) => {
    expect(consumed).toBe(2);
    expect([...new Uint8Array(await data.arrayBuffer())]).toEqual([
      137, 80, 1, 2, 3,
    ]);
  });
  await processor.run(bytes([1], [2, 3]), uploaded);
  expect(uploaded).toHaveBeenCalledTimes(1);
});

test("can asynchronously decline without consuming input", async () => {
  const input = bytes([1, 2]);
  const processor = new AttachmentStreamProcessor(
    async () => undefined,
    format,
    1,
    () => 100,
  );
  expect(await processor.run(input, vi.fn())).toBe(false);
  expect(await input.next()).toEqual({
    done: false,
    value: new Uint8Array([1, 2]),
  });
});

test("declining after reading input fails instead of falling back to incomplete source bytes", async () => {
  const processor = new AttachmentStreamProcessor(
    async ({ chunks }) => {
      await chunks[Symbol.asyncIterator]().next();
      return undefined;
    },
    format,
    1,
    () => 100,
  );
  await expect(processor.run(bytes([1]), vi.fn())).rejects.toThrow(
    "attachment_stream_declined_after_read",
  );
  expect(processor.signal.aborted).toBe(true);
});

test("an empty output intentionally suppresses capture and aborts the unused source", async () => {
  const processor = new AttachmentStreamProcessor(
    async function* () {},
    format,
    1,
    () => 100,
  );
  const uploaded = vi.fn();
  expect(await processor.run(bytes([1]), uploaded)).toBe(true);
  expect(uploaded).not.toHaveBeenCalled();
  expect(processor.signal.aborted).toBe(true);
});

test("rejects multiple consumers of the source", async () => {
  const processor = new AttachmentStreamProcessor(
    async function* ({ chunks }) {
      chunks[Symbol.asyncIterator]();
      chunks[Symbol.asyncIterator]();
    },
    format,
    1,
    () => 100,
  );
  await expect(processor.run(bytes([1]), vi.fn())).rejects.toThrow(
    "attachment_stream_already_consumed",
  );
});

test("bounds retained output and closes the inner, outer and source iterators on failure", async () => {
  const closed: string[] = [];
  const processor = new AttachmentStreamProcessor(
    async function* ({ chunks, signal }) {
      try {
        yield {
          format,
          chunks: (async function* () {
            try {
              for await (const chunk of chunks) {
                yield chunk;
                yield new Uint8Array(10);
              }
            } finally {
              expect(signal.aborted).toBe(true);
              closed.push("file");
            }
          })(),
        };
      } finally {
        closed.push("files");
      }
    },
    format,
    1,
    () => 8,
  );
  const source = (async function* () {
    try {
      yield new Uint8Array([1]);
    } finally {
      closed.push("source");
    }
  })();
  const uploaded = vi.fn();
  await expect(processor.run(source, uploaded)).rejects.toThrow(
    "capture_byte_limit",
  );
  expect(closed).toEqual(["source", "file", "files"]);
  expect(uploaded).not.toHaveBeenCalled();
  expect(processor.bufferedByteLength).toBe(0);
});

test("does not close the source twice when closing output also closes input", async () => {
  const sourceReturn = vi.fn(async () => ({
    done: true as const,
    value: undefined,
  }));
  const input = {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false as const, value: new Uint8Array([1]) }),
      return: sourceReturn,
    }),
  };
  const processor = new AttachmentStreamProcessor(
    async function* ({ chunks }) {
      yield {
        format,
        chunks: (async function* () {
          for await (const _ of chunks) yield new Uint8Array(10);
        })(),
      };
    },
    format,
    1,
    () => 8,
  );
  await expect(processor.run(input, vi.fn())).rejects.toThrow(
    "capture_byte_limit",
  );
  expect(sourceReturn).toHaveBeenCalledTimes(1);
});

test("cleans up iterators whose next rejects and contains cleanup errors", async () => {
  const closeFile = vi.fn(async () => {
    throw new Error("private cleanup");
  });
  const closeFiles = vi.fn(async () => ({
    done: true as const,
    value: undefined,
  }));
  const processor = new AttachmentStreamProcessor(
    () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({
          done: false,
          value: {
            format,
            chunks: {
              [Symbol.asyncIterator]: () => ({
                next: async () => {
                  throw new Error("private failure");
                },
                return: closeFile,
              }),
            },
          },
        }),
        return: closeFiles,
      }),
    }),
    format,
    1,
    () => 100,
  );
  await expect(processor.run(bytes([1]), vi.fn())).rejects.toThrow(
    "private failure",
  );
  expect(closeFile).toHaveBeenCalledTimes(1);
  expect(closeFiles).toHaveBeenCalledTimes(1);
});

test("logger hooks are typed and inherited without sharing configuration through SDK state", () => {
  const hook: AttachmentStreamHook = async function* (source) {
    expectTypeOf(source).toEqualTypeOf<AttachmentStreamSource>();
    yield { format: source.format, chunks: source.chunks };
  };
  const options: InitLoggerOptions<true> = { attachmentStreamHook: hook };
  const first = initLogger({
    ...options,
    projectId: "first",
    setCurrent: false,
  });
  const second = initLogger({ projectId: "second", setCurrent: false });
  expect(first.loggingState).toBe(second.loggingState);
  expectTypeOf(first).toEqualTypeOf<Logger<true>>();
  expectTypeOf(
    initLogger<false>({
      asyncFlush: false,
      attachmentStreamHook: hook,
      setCurrent: false,
    }),
  ).toEqualTypeOf<Logger<false>>();
  const child: Span & AttachmentStreamOptions = first
    .startSpan()
    .startSpan()
    .startSpan();
  expect(child[ATTACHMENT_STREAM_HOOK]).toBe(hook);
  const other: Span & AttachmentStreamOptions = second.startSpan();
  expect(other[ATTACHMENT_STREAM_HOOK]).toBeUndefined();
});

test("spans continuing an exported parent don't use a logger's hook", async () => {
  const hook: AttachmentStreamHook = async () => undefined;
  const logger = initLogger({
    projectId: "current",
    attachmentStreamHook: hook,
  });
  const exported = await initLogger({
    projectId: "exported",
    setCurrent: false,
  })
    .startSpan()
    .export();
  const spans: (Span & AttachmentStreamOptions)[] = [
    startSpan({ parent: exported }),
    logger.startSpan({ parent: exported }),
    logger.startSpan().startSpan({ parent: exported }),
  ];
  expect(logger[ATTACHMENT_STREAM_HOOK]).toBe(hook);
  for (const span of spans)
    expect(span[ATTACHMENT_STREAM_HOOK]).toBeUndefined();
});
