import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { SpanCache } from "./span-cache";
import { configureNode } from "./node/config";

// Node only exits on SIGINT and SIGTERM by default while nothing listens for
// them. The span cache adds listeners to remove its temp file, so they must
// not keep the process alive after Eval() has used the cache once.
describe("SpanCache signal handlers", () => {
  const signals = ["SIGINT", "SIGTERM"] as const;
  let cache: SpanCache | undefined;

  beforeAll(() => {
    configureNode();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cache?.stop();
    cache?.dispose();
    cache = undefined;
  });

  test("re-raises the signal after cleanup when nothing else handles it", async () => {
    const existing = Object.fromEntries(
      signals.map((signal) => [signal, process.rawListeners(signal)]),
    );
    for (const signal of signals) process.removeAllListeners(signal);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      cache = new SpanCache();
      cache.start();
      cache.queueWrite("root", "span", { span_id: "span" });
      await cache.waitForPendingWrites();

      for (const signal of signals) {
        const listeners = process.rawListeners(signal);
        expect(listeners).toHaveLength(1);
        listeners[0](signal);
        expect(process.listenerCount(signal)).toBe(0);
        expect(kill).toHaveBeenCalledWith(process.pid, signal);
      }
    } finally {
      for (const signal of signals) {
        process.removeAllListeners(signal);
        for (const listener of existing[signal]) {
          process.on(signal, listener as (...args: unknown[]) => void);
        }
      }
    }
  });
});
