import { afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { SpanCache } from "./span-cache";
import { configureNode } from "./node/config";

// Eval() turns the span cache on and every span write goes through
// queueWrite(). If the temp file cannot be created (read-only root
// filesystem, deleted tmpdir) the background flush rejects. Nothing awaits
// that promise, so Node ends the process with an unhandled rejection.
describe("SpanCache background flush failures", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const realTmpdir = process.env.TMPDIR;
  let cache: SpanCache | undefined;

  beforeAll(() => {
    configureNode();
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    if (realTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmpdir;
    cache?.stop();
    cache?.dispose();
    cache = undefined;
    unhandled.length = 0;
  });

  test("an unwritable temp dir does not cause an unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    process.env.TMPDIR = "/nonexistent-braintrust-tmp-dir";

    cache = new SpanCache();
    cache.start();
    cache.queueWrite("root-1", "span-1", { span_id: "span-1", input: "x" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    cache.queueWrite("root-2", "span-2", { span_id: "span-2", input: "y" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(unhandled).toEqual([]);
  });

  test("spans queued while the temp dir is unwritable stay readable from memory", async () => {
    process.on("unhandledRejection", onUnhandled);
    process.env.TMPDIR = "/nonexistent-braintrust-tmp-dir";

    cache = new SpanCache();
    cache.start();
    cache.queueWrite("root-1", "span-1", { span_id: "span-1", input: "x" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(cache.getByRootSpanId("root-1")).toEqual([
      { span_id: "span-1", input: "x" },
    ]);
    expect(unhandled).toEqual([]);
  });
});
