import { test, expect, vi } from "vitest";
import { wrapAnthropic, wrapAnthropicSessions } from "./anthropic";

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

test("wrapAnthropic leaves beta.sessions untouched", () => {
  const sessions = {
    events: { stream: vi.fn() },
    threads: { events: { stream: vi.fn() } },
  };
  const anthropic = {
    beta: {
      messages: { create: vi.fn(), toolRunner: vi.fn() },
      sessions,
    },
    messages: { create: vi.fn() },
  };

  expect(wrapAnthropic(anthropic).beta.sessions).toBe(sessions);
});

test("wrapAnthropicSessions wraps session and thread event streams", async () => {
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

  const wrapped = wrapAnthropicSessions(sessions);

  await expect(
    wrapped.events.stream("sesn_test", {
      event_deltas: ["agent.message"],
    }),
  ).resolves.toBe(sessionStream);
  await expect(
    wrapped.threads.events.stream("sthr_test", { session_id: "sesn_test" }),
  ).resolves.toBe(threadStream);
  expect(sessionEventsStream).toHaveBeenCalledWith("sesn_test", {
    event_deltas: ["agent.message"],
  });
  expect(threadEventsStream).toHaveBeenCalledWith("sthr_test", {
    session_id: "sesn_test",
  });
});

test("wrapAnthropicSessions returns unsupported resources unchanged", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sessions = { events: {} };

  expect(wrapAnthropicSessions(sessions)).toBe(sessions);
  expect(warnSpy).toHaveBeenCalledWith(
    "Unsupported Anthropic Sessions API. Not wrapping.",
  );

  warnSpy.mockRestore();
});
