import { test, expect, vi } from "vitest";
import { collectAnthropicSession } from "./anthropic-session-collector";
import { wrapAnthropic } from "./anthropic";

test("wrapAnthropic works even if not installed", () => {
  expect(wrapAnthropic).toBeDefined();
  expect(wrapAnthropic).toBeInstanceOf(Function);

  try {
    require("@anthropic-ai/sdk");
  } catch (e) {
    // anthropic should not be installed when this test runs
    // so make sure it's a no-op
    const x = { 1: 2 };
    const y = wrapAnthropic(x);
    expect(y).toBe(x);
  }
});

test("wrapAnthropic passively wraps beta.sessions streams", async () => {
  const sessionStream = { kind: "session" };
  const threadStream = { kind: "thread" };
  const sessionEventsStream = vi.fn(
    async (_sessionId: string, _params?: { event_deltas: string[] }) =>
      sessionStream,
  );
  const threadEventsStream = vi.fn(
    async (_threadId: string, _params: { session_id: string }) => threadStream,
  );
  const sessions = {
    events: { stream: sessionEventsStream },
    threads: { events: { stream: threadEventsStream } },
  };
  const anthropic = {
    beta: {
      messages: { create: vi.fn(), toolRunner: vi.fn() },
      sessions,
    },
    messages: { create: vi.fn() },
  };

  const wrappedSessions = wrapAnthropic(anthropic).beta.sessions;

  expect(wrappedSessions).not.toBe(sessions);
  await expect(
    wrappedSessions.events.stream("sesn_test", {
      event_deltas: ["agent.message"],
    }),
  ).resolves.toBe(sessionStream);
  await expect(
    wrappedSessions.threads.events.stream("sthr_test", {
      session_id: "sesn_test",
    }),
  ).resolves.toBe(threadStream);
  expect(sessionEventsStream).toHaveBeenCalledWith("sesn_test", {
    event_deltas: ["agent.message"],
  });
  expect(threadEventsStream).toHaveBeenCalledWith("sthr_test", {
    session_id: "sesn_test",
  });
});

test("collectAnthropicSession returns an unregistered stream unchanged", () => {
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "session.status_idle" };
    },
  };

  expect(collectAnthropicSession(stream)).toBe(stream);
});
