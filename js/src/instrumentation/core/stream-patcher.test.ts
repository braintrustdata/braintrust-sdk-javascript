import { describe, it, expect, vi } from "vitest";
import {
  isAsyncIterable,
  patchStreamIfNeeded,
  wrapStreamResult,
} from "./stream-patcher";

describe("isAsyncIterable", () => {
  it("should return true for async iterables", () => {
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
      },
    };
    expect(isAsyncIterable(asyncIterable)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isAsyncIterable(null)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(isAsyncIterable(undefined)).toBe(false);
  });

  it("should return false for objects without Symbol.asyncIterator", () => {
    expect(isAsyncIterable({})).toBe(false);
    expect(isAsyncIterable({ foo: "bar" })).toBe(false);
  });

  it("should return false for non-object types", () => {
    expect(isAsyncIterable(42)).toBe(false);
    expect(isAsyncIterable("string")).toBe(false);
    expect(isAsyncIterable(true)).toBe(false);
  });

  it("should return false for regular arrays", () => {
    expect(isAsyncIterable([1, 2, 3])).toBe(false);
  });

  it("should return false for regular iterables (non-async)", () => {
    const iterable = {
      *[Symbol.iterator]() {
        yield 1;
        yield 2;
      },
    };
    expect(isAsyncIterable(iterable)).toBe(false);
  });

  it("should return false if Symbol.asyncIterator is not a function", () => {
    const notIterable = {
      [Symbol.asyncIterator]: "not a function",
    };
    expect(isAsyncIterable(notIterable)).toBe(false);
  });

  it("should return true for async generator functions", async () => {
    async function* generator() {
      yield 1;
      yield 2;
    }
    const gen = generator();
    expect(isAsyncIterable(gen)).toBe(true);
  });
});

describe("patchStreamIfNeeded", () => {
  it("should return original value for non-async-iterables", () => {
    const value = { foo: "bar" };
    const onComplete = vi.fn();
    const result = patchStreamIfNeeded(value, { onComplete });

    expect(result).toBe(value);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("should collect chunks and call onComplete", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
        yield 3;
      },
    };

    const onComplete = vi.fn();
    const patched = patchStreamIfNeeded(stream, { onComplete });

    const chunks: number[] = [];
    for await (const chunk of patched as AsyncIterable<number>) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([1, 2, 3]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("should call onChunk for each chunk", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield "a";
        yield "b";
        yield "c";
      },
    };

    const onChunk = vi.fn();
    const onComplete = vi.fn();
    const patched = patchStreamIfNeeded(stream, { onChunk, onComplete });

    const chunks: string[] = [];
    for await (const chunk of patched as AsyncIterable<string>) {
      chunks.push(chunk);
    }

    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk).toHaveBeenNthCalledWith(1, "a");
    expect(onChunk).toHaveBeenNthCalledWith(2, "b");
    expect(onChunk).toHaveBeenNthCalledWith(3, "c");
    expect(onComplete).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("should patch the iterator returned from Symbol.asyncIterator", async () => {
    const iterator = {
      values: [1, 2, 3],
      index: 0,
      async next() {
        if (this.index >= this.values.length) {
          return { done: true, value: undefined };
        }
        const value = this.values[this.index++];
        return { done: false, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const stream = {
      next: vi.fn(async () => ({ done: true, value: undefined })),
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };

    const onChunk = vi.fn();
    const onComplete = vi.fn();
    const patched = patchStreamIfNeeded(stream, { onChunk, onComplete });

    const chunks: number[] = [];
    for await (const chunk of patched as AsyncIterable<number>) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([1, 2, 3]);
    expect(stream.next).not.toHaveBeenCalled();
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("should filter chunks with shouldCollect", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
      },
    };

    const onComplete = vi.fn();
    const shouldCollect = (chunk: number) => chunk % 2 === 0;
    const patched = patchStreamIfNeeded(stream, { onComplete, shouldCollect });

    const chunks: number[] = [];
    for await (const chunk of patched as AsyncIterable<number>) {
      chunks.push(chunk);
    }

    // All chunks should be yielded to consumer
    expect(chunks).toEqual([1, 2, 3, 4]);
    // But only even chunks should be collected
    expect(onComplete).toHaveBeenCalledWith([2, 4]);
  });

  it("should handle errors and call onError", async () => {
    const error = new Error("Stream error");
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
        throw error;
      },
    };

    const onComplete = vi.fn();
    const onError = vi.fn();
    const patched = patchStreamIfNeeded(stream, { onComplete, onError });

    await expect(async () => {
      for await (const _ of patched as AsyncIterable<number>) {
        // consume stream
      }
    }).rejects.toThrow("Stream error");

    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, [1, 2]);
  });

  it("should re-throw errors if no onError handler", async () => {
    const error = new Error("Stream error");
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        throw error;
      },
    };

    const onComplete = vi.fn();
    const patched = patchStreamIfNeeded(stream, { onComplete });

    await expect(async () => {
      for await (const _ of patched as AsyncIterable<number>) {
        // consume stream
      }
    }).rejects.toThrow("Stream error");

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("should handle early stream cancellation via return()", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
      },
    };

    const onComplete = vi.fn();
    const patched = patchStreamIfNeeded(stream, { onComplete });

    const iterator = (patched as AsyncIterable<number>)[Symbol.asyncIterator]();
    await iterator.next(); // 1
    await iterator.next(); // 2

    // Early cancellation
    if (iterator.return) {
      await iterator.return();
    }

    // onComplete should be called with collected chunks
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith([1, 2]);
  });

  it("should handle error injection via throw()", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
        yield 3;
      },
    };

    const onComplete = vi.fn();
    const onError = vi.fn();
    const patched = patchStreamIfNeeded(stream, { onComplete, onError });

    const iterator = (patched as AsyncIterable<number>)[Symbol.asyncIterator]();
    await iterator.next(); // 1
    await iterator.next(); // 2

    // Inject error
    const injectedError = new Error("Injected error");
    if (iterator.throw) {
      await expect(iterator.throw(injectedError)).rejects.toThrow(
        "Injected error",
      );
    }

    // onError should be called with collected chunks
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(injectedError, [1, 2]);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("should not double-patch streams", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
      },
    };

    const onComplete1 = vi.fn();
    const onComplete2 = vi.fn();

    const patched1 = patchStreamIfNeeded(stream, { onComplete: onComplete1 });
    const patched2 = patchStreamIfNeeded(patched1, { onComplete: onComplete2 });

    expect(patched1).toBe(patched2);

    const chunks: number[] = [];
    for await (const chunk of patched2 as AsyncIterable<number>) {
      chunks.push(chunk);
    }

    // First patch should have been called
    expect(onComplete1).toHaveBeenCalledTimes(1);
    // Second patch should not have been applied
    expect(onComplete2).not.toHaveBeenCalled();
  });

  it("should warn and return original for frozen objects", () => {
    const stream = Object.freeze({
      async *[Symbol.asyncIterator]() {
        yield 1;
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onComplete = vi.fn();

    const result = patchStreamIfNeeded(stream, { onComplete });

    expect(result).toBe(stream);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot patch frozen/sealed stream"),
    );

    warnSpy.mockRestore();
  });

  it("should warn and return original for sealed objects", () => {
    const stream = Object.seal({
      async *[Symbol.asyncIterator]() {
        yield 1;
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onComplete = vi.fn();

    const result = patchStreamIfNeeded(stream, { onComplete });

    expect(result).toBe(stream);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot patch frozen/sealed stream"),
    );

    warnSpy.mockRestore();
  });

  it("should catch and log errors in onComplete handler", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
      },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onComplete = vi.fn(() => {
      throw new Error("Handler error");
    });

    const patched = patchStreamIfNeeded(stream, { onComplete });

    for await (const _ of patched as AsyncIterable<number>) {
      // consume stream
    }

    expect(onComplete).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error in stream onComplete handler"),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("should catch and log errors in onChunk handler", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
      },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onChunk = vi.fn(() => {
      throw new Error("Chunk handler error");
    });
    const onComplete = vi.fn();

    const patched = patchStreamIfNeeded(stream, { onChunk, onComplete });

    for await (const _ of patched as AsyncIterable<number>) {
      // consume stream
    }

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error in stream onChunk handler"),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("should catch and log errors in onError handler", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        throw new Error("Stream error");
      },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn(() => {
      throw new Error("Error handler error");
    });

    const patched = patchStreamIfNeeded(stream, {
      onComplete: vi.fn(),
      onError,
    });

    await expect(async () => {
      for await (const _ of patched as AsyncIterable<number>) {
        // consume stream
      }
    }).rejects.toThrow("Stream error");

    expect(onError).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error in stream onError handler"),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });
});

describe("wrapStreamResult", () => {
  it("should handle async iterable with processChunks", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { delta: "a" };
        yield { delta: "b" };
        yield { delta: "c" };
      },
    };

    const processChunks = vi.fn((chunks: any[]) => ({
      text: chunks.map((c) => c.delta).join(""),
      count: chunks.length,
    }));
    const onResult = vi.fn();

    const result = wrapStreamResult(stream, { processChunks, onResult });

    // Consume the stream
    for await (const _ of result as AsyncIterable<any>) {
      // consume
    }

    expect(processChunks).toHaveBeenCalledWith([
      { delta: "a" },
      { delta: "b" },
      { delta: "c" },
    ]);
    expect(onResult).toHaveBeenCalledWith({ text: "abc", count: 3 });
  });

  it("should handle non-stream with onNonStream", () => {
    const result = { foo: "bar" };

    const processChunks = vi.fn();
    const onNonStream = vi.fn((r) => ({ processed: r }));
    const onResult = vi.fn();

    const returned = wrapStreamResult(result, {
      processChunks,
      onNonStream,
      onResult,
    });

    expect(returned).toBe(result);
    expect(processChunks).not.toHaveBeenCalled();
    expect(onNonStream).toHaveBeenCalledWith(result);
    expect(onResult).toHaveBeenCalledWith({ processed: result });
  });

  it("should handle non-stream without onNonStream", () => {
    const result = { foo: "bar" };

    const processChunks = vi.fn();
    const onResult = vi.fn();

    const returned = wrapStreamResult(result, { processChunks, onResult });

    expect(returned).toBe(result);
    expect(processChunks).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it("should handle errors in processChunks", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
      },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const processChunks = vi.fn(() => {
      throw new Error("Process error");
    });
    const onResult = vi.fn();
    const onError = vi.fn();

    const result = wrapStreamResult(stream, {
      processChunks,
      onResult,
      onError,
    });

    for await (const _ of result as AsyncIterable<number>) {
      // consume
    }

    expect(processChunks).toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error processing stream chunks"),
      expect.any(Error),
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), [1]);

    errorSpy.mockRestore();
  });

  it("should handle errors in onNonStream", () => {
    const result = { foo: "bar" };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const processChunks = vi.fn();
    const onNonStream = vi.fn(() => {
      throw new Error("Non-stream error");
    });
    const onResult = vi.fn();
    const onError = vi.fn();

    wrapStreamResult(result, {
      processChunks,
      onNonStream,
      onResult,
      onError,
    });

    expect(onNonStream).toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Error processing non-stream result"),
      expect.any(Error),
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), []);

    errorSpy.mockRestore();
  });

  it("should filter chunks with shouldCollect", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
      },
    };

    const processChunks = vi.fn((chunks) => chunks);
    const onResult = vi.fn();
    const shouldCollect = (chunk: number) => chunk % 2 === 0;

    const result = wrapStreamResult(stream, {
      processChunks,
      onResult,
      shouldCollect,
    });

    for await (const _ of result as AsyncIterable<number>) {
      // consume
    }

    expect(processChunks).toHaveBeenCalledWith([2, 4]);
  });

  it("should call onError for stream errors", async () => {
    const error = new Error("Stream error");
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        throw error;
      },
    };

    const processChunks = vi.fn();
    const onResult = vi.fn();
    const onError = vi.fn();

    const result = wrapStreamResult(stream, {
      processChunks,
      onResult,
      onError,
    });

    await expect(async () => {
      for await (const _ of result as AsyncIterable<number>) {
        // consume
      }
    }).rejects.toThrow("Stream error");

    expect(onError).toHaveBeenCalledWith(error, [1]);
    expect(processChunks).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
