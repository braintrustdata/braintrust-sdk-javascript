import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _exportsForTestingOnly,
  currentSpan,
  initLogger,
  NOOP_SPAN,
  type TestBackgroundLogger,
} from "../../logger";
import { configureNode } from "../../node/config";
import { channel, defineChannels } from "./channel-definitions";
import { traceAsyncChannel } from "./channel-tracing";

const testChannels = defineChannels("channel-tracing-test", {
  asyncCall: channel<[Record<string, never>], { ok: true }>({
    channelName: "async.call",
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
});
