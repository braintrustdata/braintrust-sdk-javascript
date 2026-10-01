import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { LoggingEvent } from "../util";
import {
  _exportsForTestingOnly,
  currentSpan,
  initLogger,
  startSpan,
  withCurrent,
} from "./logger";
import { configureNode } from "./node/config";
import {
  captureLiveKitTrace,
  startLiveKitSessionTrace,
  startLiveKitTurnTrace,
} from "./livekit-trace";

configureNode();
let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(async () => _exportsForTestingOnly.simulateLoginForTests());
beforeEach(() => {
  background = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({
    projectName: "tmp-luca-livekit-capture",
    projectId: "test-project-id",
  });
});
afterEach(() => _exportsForTestingOnly.clearTestBackgroundLogger());

it("records pending inputs without changing ambient context, and explicitly parents turns", async () => {
  const outer = startSpan({ name: "outer" });
  const session = withCurrent(outer, () => {
    const session = startLiveKitSessionTrace({
      sessionId: "session-1",
      startTime: 100,
    });
    expect(currentSpan()).toBe(outer);
    return session;
  });
  const turn = startLiveKitTurnTrace({
    parent: session,
    operation: "generateReply",
    input: "Hello",
    startTime: 101,
  });
  const rows = (await background.drain()) as LoggingEvent[];
  expect(rows.find((row) => row.id === session.id)).toMatchObject({
    span_parents: [outer.spanId],
    span_attributes: { name: "livekit.session", type: "task" },
    metadata: { session_id: "session-1", status: "pending" },
    metrics: { start: 100 },
  });
  const row = rows.find((row) => row.id === turn.id)!;
  expect(row).toMatchObject({
    span_parents: [session.spanId],
    root_span_id: session.rootSpanId,
    input: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    metadata: { operation: "generateReply", status: "pending" },
    metrics: { start: 101 },
  });
  expect(row.metrics?.end).toBeUndefined();
});

it.each(["completed", "interrupted", "cancelled", "failed"] as const)(
  "captures %s without inventing errors",
  async (status) => {
    const session = startLiveKitSessionTrace();
    const turn = startLiveKitTurnTrace({
      parent: await session.export(),
      operation: "say",
    });
    captureLiveKitTrace({
      span: turn,
      status,
      output: "Goodbye",
      endTime: 200,
      ...(status === "failed" ? { error: new Error("submission failed") } : {}),
    });
    const rows = (await background.drain()) as LoggingEvent[];
    const row = rows.find((row) => row.id === turn.id)!;
    expect(row).toMatchObject({
      metadata: { status },
      metrics: { end: 200 },
      output: [
        { role: "assistant", content: [{ type: "text", text: "Goodbye" }] },
      ],
    });
    if (status === "failed") expect(row.error).toContain("submission failed");
    else expect(row.error).toBeUndefined();
    expect(
      rows.find((row) => row.id === session.id)?.metrics?.end,
    ).toBeUndefined();
  },
);

it("updates exported context in place, replaces snapshots, and does not create duplicate outcomes", async () => {
  const session = startLiveKitSessionTrace();
  const turn = startLiveKitTurnTrace({
    parent: session,
    operation: "voice",
    input: "Before",
  });
  const exported = await turn.export();
  const initial = ((await background.drain()) as LoggingEvent[]).find(
    (row) => row.id === turn.id,
  )!;
  captureLiveKitTrace({
    span: exported,
    status: "pending",
    speechId: "speech-1",
    input: "After",
    output: "Partial",
  });
  const pending = (await background.drain()) as LoggingEvent[];
  expect(pending).toHaveLength(1);
  expect(pending[0].metrics?.end).toBeUndefined();
  const outcome = {
    span: exported,
    status: "completed" as const,
    output: "Final",
    endTime: 300,
  };
  captureLiveKitTrace(outcome);
  captureLiveKitTrace(outcome);
  const rows = (await background.drain()) as LoggingEvent[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: initial.id,
    span_id: initial.span_id,
    root_span_id: initial.root_span_id,
    output: [{ role: "assistant", content: [{ type: "text", text: "Final" }] }],
    metrics: { end: 300 },
  });
  expect(rows[0].span_parents).toBeUndefined(); // Updates must preserve the original parents.
});

it("keeps overlapping sessions and turns independent and does not cascade completion", async () => {
  const a = startLiveKitSessionTrace({ sessionId: "a" });
  const b = startLiveKitSessionTrace({ sessionId: "b" });
  const one = startLiveKitTurnTrace({ parent: a, operation: "run" });
  const two = startLiveKitTurnTrace({ parent: a, operation: "voice" });
  const three = startLiveKitTurnTrace({ parent: b, operation: "say" });
  captureLiveKitTrace({ span: two, status: "interrupted", endTime: 2 });
  captureLiveKitTrace({ span: a, status: "completed", endTime: 3 });
  const rows = (await background.drain()) as LoggingEvent[];
  for (const span of [one, three, b])
    expect(
      rows.find((row) => row.id === span.id)?.metrics?.end,
    ).toBeUndefined();
  expect(rows.find((row) => row.id === three.id)?.span_parents).toEqual([
    b.spanId,
  ]);
});

it("uses explicit exported parents over ambient context and ignores non-allowlisted metadata", async () => {
  const session = startLiveKitSessionTrace({ sessionId: "expected" });
  const unrelated = startSpan({ name: "unrelated" });
  const parent = await session.export();
  const options = {
    parent,
    operation: "run" as const,
    metadata: { api_key: "must-not-be-captured" },
  };
  const turn = withCurrent(unrelated, () => startLiveKitTurnTrace(options));
  captureLiveKitTrace({ span: turn, status: "pending", output: "Old output" });
  captureLiveKitTrace({ span: turn, status: "completed", output: [] });
  const rows = (await background.drain()) as LoggingEvent[];
  const row = rows.find((row) => row.id === turn.id)!;
  expect(row.span_parents).toEqual([session.spanId]);
  expect(row.output).toEqual([]);
  expect(row.metadata).toEqual({ operation: "run", status: "completed" });
  expect(JSON.stringify(rows)).not.toContain("must-not-be-captured");
});

it("ignores invalid and disabled exported capture contexts without affecting caller execution", () => {
  expect(() =>
    captureLiveKitTrace({
      span: "invalid context",
      status: "failed",
      error: "Provider failed",
    }),
  ).not.toThrow();
  expect(() =>
    captureLiveKitTrace({ span: "", status: "completed" }),
  ).not.toThrow();
});

it("keeps text and remote references, omits media bytes, and never consumes lazy results", async () => {
  const consume = vi.fn(() => {
    throw new Error("must not execute");
  });
  const session = startLiveKitSessionTrace({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          "Hello",
          { type: "image_content", image: "https://example.com/image.png" },
          { type: "image_content", image: "data:image/png;base64,c2VjcmV0" },
          { type: "audio_content", transcript: "Voice", frame: [] },
        ],
      },
    ],
  });
  const lazy = {
    then: consume,
    [Symbol.asyncIterator]: consume,
    wait: consume,
    on: consume,
  };
  // @ts-expect-error SDK handles are not accepted, even if supplied by untyped callers.
  captureLiveKitTrace({ span: session, status: "pending", output: lazy });
  expect(consume).not.toHaveBeenCalled();
  const rows = (await background.drain()) as LoggingEvent[];
  expect(rows[0].input).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/image.png" },
        },
        { type: "text", text: "Voice" },
      ],
    },
  ]);
  expect(rows[0].output).toBeUndefined();
});
