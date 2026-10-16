import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import type { Span } from "../../logger";
import { RealtimeMetrics } from "./realtime-metrics";

function usage(requestId: string, inputTokens = 12) {
  return {
    type: "realtime_model_metrics",
    requestId,
    inputTokens,
    outputTokens: 3,
    inputTokenDetails: { textTokens: 8, audioTokens: 4, cachedTokens: 2 },
    outputTokenDetails: { textTokens: 1, audioTokens: 2 },
    ttftMs: 250,
  };
}
function span() {
  const log = vi.fn();
  return { log, span: { log } as unknown as Span };
}

test.each([true, false])(
  "native usage retains request identity when metrics arrive first: %s",
  (early) => {
    const session = new EventEmitter();
    const observer = new RealtimeMetrics(session);
    const a = span(),
      b = span();
    if (early) {
      session.emit("metrics_collected", usage("b", 20));
      session.emit("metrics_collected", usage("a"));
    }
    observer.associate("a", a.span);
    observer.associate("b", b.span);
    if (!early) {
      session.emit("metrics_collected", usage("b", 20));
      session.emit("metrics_collected", usage("a"));
    }
    expect(a.log).toHaveBeenCalledExactlyOnceWith({
      metadata: expect.objectContaining({
        "gen_ai.response.id": "a",
        "gen_ai.usage.audio.input_tokens": 4,
      }),
      metrics: {
        prompt_tokens: 12,
        completion_tokens: 3,
        tokens: 15,
        cache_read_input_tokens: 2,
        time_to_first_token: 0.25,
      },
    });
    expect(b.log.mock.calls[0][0].metrics.tokens).toBe(23);
    observer.close();
  },
);

test("discarded requests cannot block or steal later usage; stale unmatched metrics expire", () => {
  const session = new EventEmitter();
  const observer = new RealtimeMetrics(session);
  for (let i = 0; i < 1000; i++)
    session.emit("metrics_collected", usage(`discarded-${i}`));
  const stale = span(),
    active = span();
  observer.associate("discarded-0", stale.span);
  observer.associate("active", active.span);
  session.emit("metrics_collected", usage("active"));
  expect(stale.log).not.toHaveBeenCalled();
  expect(active.log).toHaveBeenCalledOnce();
  observer.close();
  expect(session.listenerCount("metrics_collected")).toBe(0);
});

test("sessions with identical request IDs are isolated and close releases unmatched data", () => {
  const first = new EventEmitter(),
    second = new EventEmitter();
  const a = new RealtimeMetrics(first),
    b = new RealtimeMetrics(second);
  const output = span();
  first.emit("metrics_collected", usage("same", 100));
  b.associate("same", output.span);
  expect(output.log).not.toHaveBeenCalled();
  a.close();
  second.emit("metrics_collected", usage("same"));
  expect(output.log.mock.calls[0][0].metrics.tokens).toBe(15);
  b.close();
});
