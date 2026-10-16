import { expect, test, vi } from "vitest";
import { observeStream } from "./streams";

test("observes reads without prefetch and forwards cancellation", async () => {
  const pull = vi.fn((c: ReadableStreamDefaultController<string>) =>
    c.enqueue("text"),
  );
  const cancel = vi.fn();
  const value = vi.fn();
  const done = vi.fn();
  const source = new ReadableStream<string>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  const stream = observeStream(source, value, done);
  await Promise.resolve();
  expect(pull).not.toHaveBeenCalled();
  const reader = stream.getReader();
  expect(await reader.read()).toEqual({ done: false, value: "text" });
  expect(value).toHaveBeenCalledExactlyOnceWith("text");
  await reader.cancel("interrupted");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("interrupted");
  expect(done).toHaveBeenCalledOnce();
  expect(source.locked).toBe(false);
});

test("pipeTo observes each consumed item once, preserving stream failures", async () => {
  const failure = new Error("upstream");
  let controller!: ReadableStreamDefaultController<string>;
  const source = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });
  const value = vi.fn();
  const done = vi.fn();
  const stream = observeStream(source, value, done);
  const received: string[] = [];
  const piped = stream.pipeTo(
    new WritableStream({
      write(text) {
        received.push(text);
      },
    }),
  );
  controller.enqueue("hello");
  // Wait for actual consumption before making the upstream fail.
  await vi.waitFor(() => expect(received).toEqual(["hello"]));
  controller.error(failure);
  await expect(piped).rejects.toBe(failure);
  expect(value).toHaveBeenCalledExactlyOnceWith("hello");
  expect(done).toHaveBeenCalledOnce();
});
