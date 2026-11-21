import { expect, test } from "vite-plus/test";
import { livekitChannels } from "./livekit-interceptors";
import {
  wrapLiveKitModelQueue,
  wrapLiveKitModelWorker,
} from "./livekit-wrapping";

test("producer observation follows successful enqueue and never reads the consumer", () => {
  const order: string[] = [];
  const output = { delta: "first attempt" };
  const stream = {
    queue: {
      put(value: unknown) {
        expect(value).toBe(output);
        order.push("put");
        return output;
      },
    },
    next() {
      throw new Error("consumer must not be read");
    },
  };
  const remove = livekitChannels.modelEnqueue.intercept(
    (target, receiver, args, additional) => {
      const result = Reflect.apply(target, receiver, args);
      expect(additional.stream).toBe(stream);
      order.push("observe");
      return result;
    },
  );
  try {
    expect(wrapLiveKitModelQueue(stream)).toBe(true);
    expect(wrapLiveKitModelQueue(stream)).toBe(true);
    expect(stream.queue.put(output)).toBe(output);
    expect(order).toEqual(["put", "observe"]);
  } finally {
    remove();
  }
});

test("failed enqueue preserves the error and does not report accepted output", () => {
  const failure = new Error("queue closed");
  const stream = {
    queue: {
      put() {
        throw failure;
      },
    },
  };
  let observed = false;
  const remove = livekitChannels.modelEnqueue.intercept(
    (target, receiver, args) => {
      const result = Reflect.apply(target, receiver, args);
      observed = true;
      return result;
    },
  );
  try {
    wrapLiveKitModelQueue(stream);
    expect(() => stream.queue.put()).toThrow(failure);
    expect(observed).toBe(false);
  } finally {
    remove();
  }
});

test("worker hooks preserve promise identity, receiver, arguments and idempotence", () => {
  const output = Promise.resolve("result");
  const stream = {
    run(value: string) {
      expect(this).toBe(stream);
      expect(value).toBe("argument");
      return output;
    },
  };
  let observed = 0;
  const remove = livekitChannels.modelRun.intercept(
    (target, receiver, args) => {
      observed++;
      return Reflect.apply(target, receiver, args);
    },
  );
  try {
    wrapLiveKitModelWorker(stream);
    wrapLiveKitModelWorker(stream);
    expect(stream.run("argument")).toBe(output);
    expect(observed).toBe(1);
  } finally {
    remove();
  }
});
