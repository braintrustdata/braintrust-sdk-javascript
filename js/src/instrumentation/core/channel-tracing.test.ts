import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  _exportsForTestingOnly,
  currentSpan,
  initLogger,
  NOOP_SPAN,
  type Span,
  type TestBackgroundLogger,
} from "../../logger";
import { configureNode } from "../../node/config";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { channel, defineChannels } from "./channel-definitions";
import { traceAsyncChannel, traceStreamingChannel } from "./channel-tracing";

const testChannels = defineChannels("channel-tracing-test", {
  asyncCall: channel<[Record<string, unknown>], { ok: true }>({
    channelName: "async.call",
    kind: "async",
  }),
  streamingCall: channel<[Record<string, unknown>], { ok: true }>({
    channelName: "streaming.call",
    kind: "async",
  }),
});

describe("traceAsyncChannel current span binding", () => {
  let backgroundLogger: TestBackgroundLogger;

  beforeAll(async () => {
    configureNode();
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "channel-tracing.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("binds the created span into the traced async execution context", async () => {
    const unsubscribe = traceAsyncChannel(testChannels.asyncCall, {
      name: "channel-tracing-test",
      type: "function",
      extractInput: () => ({
        input: "input",
        metadata: undefined,
      }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
    });

    const seenSpanIds: string[] = [];

    try {
      await testChannels.asyncCall.tracePromise(
        async () => {
          seenSpanIds.push(currentSpan().spanId);
          await Promise.resolve();
          seenSpanIds.push(currentSpan().spanId);

          return { ok: true as const };
        },
        { arguments: [{}] } as any,
      );
    } finally {
      unsubscribe();
    }

    expect(seenSpanIds).toHaveLength(2);
    expect(seenSpanIds[0]).toBeTruthy();
    expect(seenSpanIds[1]).toBe(seenSpanIds[0]);
    expect(currentSpan()).toBe(NOOP_SPAN);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
  });

  it("does not create a span when shouldTrace returns false", async () => {
    const unsubscribe = traceAsyncChannel(testChannels.asyncCall, {
      name: "channel-tracing-test",
      shouldTrace: ([params]) =>
        !(
          typeof params === "object" &&
          params !== null &&
          "skip" in params &&
          params.skip === true
        ),
      type: "function",
      extractInput: () => ({
        input: "input",
        metadata: undefined,
      }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
    });

    const seenSpanIds: string[] = [];

    try {
      await testChannels.asyncCall.tracePromise(
        async () => {
          seenSpanIds.push(currentSpan().spanId);
          await Promise.resolve();
          seenSpanIds.push(currentSpan().spanId);

          return { ok: true as const };
        },
        { arguments: [{ skip: true }] } as any,
      );
    } finally {
      unsubscribe();
    }

    expect(seenSpanIds).toEqual(["", ""]);
    expect(currentSpan()).toBe(NOOP_SPAN);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(0);
  });

  it("uses debug logging when shouldTrace throws", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const unsubscribe = traceAsyncChannel(testChannels.asyncCall, {
      name: "channel-tracing-test",
      shouldTrace: () => {
        throw new Error("predicate failed");
      },
      type: "function",
      extractInput: () => ({
        input: "input",
        metadata: undefined,
      }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
    });

    try {
      await testChannels.asyncCall.tracePromise(
        async () => ({ ok: true as const }),
        { arguments: [{}] } as any,
      );
    } finally {
      unsubscribe();
    }

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
  });

  it("skips auto instrumentation spans while suppression is active", async () => {
    const unsubscribe = traceAsyncChannel(testChannels.asyncCall, {
      name: "channel-tracing-test",
      type: "function",
      extractInput: () => ({
        input: "input",
        metadata: undefined,
      }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
    });

    try {
      await runWithAutoInstrumentationSuppressed(() =>
        testChannels.asyncCall.tracePromise(
          async () => {
            expect(currentSpan()).toBe(NOOP_SPAN);
            await Promise.resolve();
            expect(currentSpan()).toBe(NOOP_SPAN);

            return { ok: true as const };
          },
          { arguments: [{}] } as any,
        ),
      );
    } finally {
      unsubscribe();
    }

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(0);
  });

  it("runs streaming cleanup hooks when span logging fails", async () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const end = vi.fn();
    const child = {
      end,
      log: vi.fn(() => {
        throw new Error("logging failed");
      }),
    } as unknown as Span;
    const parent = {
      startSpan: vi.fn(() => child),
    } as unknown as Span;
    const unsubscribe = traceStreamingChannel(testChannels.streamingCall, {
      name: "streaming-channel-test",
      parent: () => parent,
      type: "function",
      extractInput: () => ({ input: "input", metadata: undefined }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
      onComplete,
      onError,
    });

    try {
      await expect(
        testChannels.streamingCall.tracePromise(
          async () => ({ ok: true as const }),
          { arguments: [{}] } as any,
        ),
      ).resolves.toEqual({ ok: true });
      await expect(
        testChannels.streamingCall.tracePromise(
          async () => {
            throw new Error("call failed");
          },
          { arguments: [{}] } as any,
        ),
      ).rejects.toThrow("call failed");
    } finally {
      unsubscribe();
    }

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(2);
  });
});
