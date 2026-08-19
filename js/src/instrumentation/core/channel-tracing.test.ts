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
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { channel, defineChannels } from "./channel-definitions";
import { traceAsyncChannel, traceStreamingChannel } from "./channel-tracing";

const testChannels = defineChannels(
  "channel-tracing-test",
  {
    asyncBinding: channel<[Record<string, unknown>], { ok: true }>({
      channelName: "async.binding",
      kind: "async",
    }),
    provenance: channel<[Record<string, unknown>], { ok: true }>({
      channelName: "async.provenance",
      kind: "async",
    }),
    skipped: channel<[Record<string, unknown>], { ok: true }>({
      channelName: "async.skipped",
      kind: "async",
    }),
    throwingPredicate: channel<[Record<string, unknown>], { ok: true }>({
      channelName: "async.throwing-predicate",
      kind: "async",
    }),
    suppressed: channel<[Record<string, unknown>], { ok: true }>({
      channelName: "async.suppressed",
      kind: "async",
    }),
    streamingCleanup: channel<[Record<string, unknown>], { ok: true }>({
      channelName: "streaming.cleanup",
      kind: "async",
    }),
    streamingCancellation: channel<[Record<string, unknown>], { ok: true }>({
      channelName: "streaming.cancellation",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.OPENAI },
);

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
    traceAsyncChannel(testChannels.asyncBinding, {
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

    await testChannels.asyncBinding.tracePromise(
      async () => {
        seenSpanIds.push(currentSpan().spanId);
        await Promise.resolve();
        seenSpanIds.push(currentSpan().spanId);

        return { ok: true as const };
      },
      { arguments: [{}] } as any,
    );
    expect(seenSpanIds).toHaveLength(2);
    expect(seenSpanIds[0]).toBeTruthy();
    expect(seenSpanIds[1]).toBe(seenSpanIds[0]);
    expect(currentSpan()).toBe(NOOP_SPAN);

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(spans).toHaveLength(1);
    expect(spans[0]?.context?.span_origin).toMatchObject({
      instrumentation: { name: INSTRUMENTATION_NAMES.OPENAI },
    });
  });

  it("limits channel provenance to directly instrumented spans", async () => {
    traceAsyncChannel(testChannels.provenance, {
      name: "channel-parent",
      type: "function",
      extractInput: () => ({ input: "input", metadata: undefined }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
    });

    await testChannels.provenance.tracePromise(
      async () => {
        const parent = currentSpan();
        parent.startSpan({ name: "user-child" }).end();
        parent
          .startSpanWithParents("user-multi-parent-child", [parent.spanId], {
            name: "user-multi-parent-child",
          })
          .end();
        parent
          .startSpan(
            withSpanInstrumentationName(
              { name: "instrumentation-child" },
              INSTRUMENTATION_NAMES.OPENAI,
            ),
          )
          .end();
        return { ok: true as const };
      },
      { arguments: [{}] } as any,
    );
    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(spans).toHaveLength(4);

    for (const name of ["channel-parent", "instrumentation-child"]) {
      const span = spans.find(
        (candidate) => candidate.span_attributes?.name === name,
      );
      expect(span?.context?.span_origin).toMatchObject({
        instrumentation: { name: INSTRUMENTATION_NAMES.OPENAI },
      });
    }
    for (const name of ["user-child", "user-multi-parent-child"]) {
      const span = spans.find(
        (candidate) => candidate.span_attributes?.name === name,
      );
      expect(span?.context?.span_origin).toMatchObject({
        instrumentation: { name: "braintrust-js-logger" },
      });
    }
  });

  it("does not create a span when shouldTrace returns false", async () => {
    traceAsyncChannel(testChannels.skipped, {
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

    await testChannels.skipped.tracePromise(
      async () => {
        seenSpanIds.push(currentSpan().spanId);
        await Promise.resolve();
        seenSpanIds.push(currentSpan().spanId);

        return { ok: true as const };
      },
      { arguments: [{ skip: true }] } as any,
    );
    expect(seenSpanIds).toEqual(["", ""]);
    expect(currentSpan()).toBe(NOOP_SPAN);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(0);
  });

  it("uses debug logging when shouldTrace throws", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    traceAsyncChannel(testChannels.throwingPredicate, {
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

    await testChannels.throwingPredicate.tracePromise(
      async () => ({ ok: true as const }),
      { arguments: [{}] } as any,
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
  });

  it("skips auto instrumentation spans while suppression is active", async () => {
    traceAsyncChannel(testChannels.suppressed, {
      name: "channel-tracing-test",
      type: "function",
      extractInput: () => ({
        input: "input",
        metadata: undefined,
      }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
    });

    await runWithAutoInstrumentationSuppressed(() =>
      testChannels.suppressed.tracePromise(
        async () => {
          expect(currentSpan()).toBe(NOOP_SPAN);
          await Promise.resolve();
          expect(currentSpan()).toBe(NOOP_SPAN);

          return { ok: true as const };
        },
        { arguments: [{}] } as any,
      ),
    );
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
    traceStreamingChannel(testChannels.streamingCleanup, {
      name: "streaming-channel-test",
      startSpan: () => child,
      type: "function",
      extractInput: () => ({ input: "input", metadata: undefined }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
      onComplete,
      onError,
    });

    await expect(
      testChannels.streamingCleanup.tracePromise(
        async () => ({ ok: true as const }),
        { arguments: [{}] } as any,
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      testChannels.streamingCleanup.tracePromise(
        async () => {
          throw new Error("call failed");
        },
        { arguments: [{}] } as any,
      ),
    ).rejects.toThrow("call failed");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(2);
  });

  it("records stream cancellation as an error", async () => {
    const onError = vi.fn();
    const child = {
      end: vi.fn(),
      log: vi.fn(),
    } as unknown as Span;
    traceStreamingChannel(testChannels.streamingCancellation, {
      name: "streaming-channel-test",
      startSpan: () => child,
      type: "function",
      extractInput: () => ({ input: "input", metadata: undefined }),
      extractOutput: (result) => result,
      extractMetrics: () => ({}),
      onError,
    });
    const stream = {
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { ok: true };
      },
    };

    const patched = await testChannels.streamingCancellation.tracePromise(
      async () => stream as any,
      { arguments: [{}] } as any,
    );
    (patched as unknown as typeof stream).abort();
    await Promise.resolve();
    const cancellationError = expect.objectContaining({
      message: "Stream cancelled before completion",
      name: "AbortError",
    });
    expect(child.log).toHaveBeenLastCalledWith({ error: cancellationError });
    expect(child.end).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: cancellationError }),
    );
  });
});
