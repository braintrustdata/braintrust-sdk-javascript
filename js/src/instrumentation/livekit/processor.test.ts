/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { configureNode } from "../../node/config";
configureNode();
import { LiveKitSpanProcessor } from "./processor";
import * as audioOptions from "./node/audio-options";
import * as audioExtension from "../../../../integrations/audio/src/index";
import * as audioWorker from "../../../../integrations/audio/src/worker";
import { encodeCall } from "../../../../integrations/audio/src/pcm";
import { Attachment } from "../../logger";
import { channel, defineChannels } from "../core/channel-definitions";
import { traceAsyncChannel } from "../core/channel-tracing";
let processor: LiveKitSpanProcessor | undefined;
afterEach(async () => {
  await processor?.shutdown();
  processor = undefined;
});
function fixture(
  captureContent = false,
  options: Partial<ConstructorParameters<typeof LiveKitSpanProcessor>[0]> = {},
) {
  options = { audioFormat: "wav", ...options };
  const rows: {
    args: any;
    parent?: string;
    logs: any[];
    end: any;
    spanId: string;
  }[] = [];
  function owner(parent?: string): any {
    return {
      flush: async () => {},
      startSpan(args: any) {
        const row = {
          args,
          parent,
          logs: [] as any[],
          end: undefined as any,
          spanId: String(rows.length),
        };
        rows.push(row);
        return {
          ...owner(row.spanId),
          spanId: row.spanId,
          log(event: any) {
            row.logs.push(event);
          },
          end(event: any) {
            row.end = event;
          },
        };
      },
    };
  }
  processor = new LiveKitSpanProcessor({
    logger: owner(),
    captureContent,
    captureUserAudio: false,
    captureAgentAudio: false,
    ...options,
  });
  const span = (
    id: string,
    name: string,
    parent?: string,
    attributes: any = {},
  ) => ({
    name,
    spanContext: () => ({ spanId: id, traceId: "trace" }),
    parentSpanContext: parent ? { spanId: parent } : undefined,
    startTime: [1, 0] as [number, number],
    endTime: [2, 0] as [number, number],
    attributes,
    events: [],
    status: { code: 0 },
  });
  return { rows, span, p: processor };
}
test("native hierarchy and inference types survive; namespace and tool payloads are normalized", () => {
  const { rows, span, p } = fixture(true);
  const root = span("s", "agent_session"),
    turn = span("t", "agent_turn", "s"),
    model = span("m", "realtime_inference", "t"),
    tool = span("f", "function_tool", "t", {
      "lk.function_tool.name": "lookup_order",
      "gen_ai.tool.call.id": "call-1",
      "lk.pii.function_tool.arguments": '{"id":1}',
      "lk.pii.function_tool.output": '{"ok":true}',
    });
  for (const s of [root, turn, model, tool]) p.onStart(s);
  for (const s of [model, tool, turn, root]) p.onEnd(s);
  expect(rows.map((r) => r.parent)).toEqual([undefined, "0", "1", "1"]);
  expect(rows[2].args.type).toBe("llm");
  expect(
    rows[3].logs.some((e: any) => e.span_attributes?.name === "lookup_order"),
  ).toBe(true);
  expect(rows[3].logs.find((e: any) => e.input)?.input).toEqual({ id: 1 });
  expect(rows.every((r) => r.end.endTime === 2)).toBe(true);
  expect(p.rows.size).toBe(0);
});
test("content opt-out retains timing and IDs without logging transcript or tool content", () => {
  const { rows, span, p } = fixture(false),
    root = span("s", "agent_session"),
    turn = span("t", "agent_turn", "s", {
      "lk.pii.user_input": "secret",
      "lk.speech_id": "speech",
      "gen_ai.input.messages": "secret",
    });
  p.onStart(root);
  p.onStart(turn);
  p.onEnd(turn);
  p.onEnd(root);
  expect(JSON.stringify(rows)).not.toContain("secret");
  expect(JSON.stringify(rows)).toContain("livekit.speech_id");
});
test("concurrent sessions keep parents separate; closing one does not clear another", () => {
  const { rows, span, p } = fixture(),
    a = span("a", "agent_session"),
    b = span("b", "agent_session"),
    child = span("t", "agent_turn", "a");
  p.onStart(a);
  p.onStart(b);
  p.onStart(child);
  p.onEnd(a);
  expect(rows[2].parent).toBe("0");
  expect(p.rows.has("b")).toBe(true);
  p.onEnd(b);
});
test("late tool completion keeps its native owner after the session ends", () => {
  const { rows, span, p } = fixture(true);
  const root = span("root", "agent_session"),
    turn = span("turn", "agent_turn", "root"),
    tool = span("tool", "function_tool", "turn", {
      "gen_ai.tool.name": "late_tool",
      "gen_ai.tool.call.result": '{"ok":true}',
    });
  for (const s of [root, turn, tool]) p.onStart(s);
  p.onEnd(turn);
  p.onEnd(root);
  expect(p.rows.has("tool")).toBe(true);
  p.onEnd(tool);
  expect(rows[2].logs.find((event: any) => event.output)?.output).toEqual({
    ok: true,
  });
  expect(rows[2].parent).toBe("1");
  expect(p.rows.size).toBe(0);
});
test("committed messages retain identity and honor content opt-out", () => {
  const { rows, span, p } = fixture(false),
    root = span("root", "agent_session");
  p.onStart(root);
  p.conversation(
    { sessionSpan: root },
    { type: "message", id: "item", role: "user", textContent: "private" },
  );
  p.onEnd(root);
  expect(JSON.stringify(rows)).not.toContain("private");
});
test("late realtime user transcript is not assigned to the currently speaking agent", () => {
  const { rows, span, p } = fixture(true),
    root = span("root", "agent_session"),
    turn = span("turn", "agent_turn", "root");
  p.onStart(root);
  p.onStart(turn);
  const session: any = {
    sessionSpan: root,
    activity: { currentSpeech: { _agentTurnSpan: turn } },
  };
  p.conversation(session, {
    type: "message",
    id: "input-item",
    role: "user",
    textContent: "late transcript",
  });
  p.conversation(session, {
    type: "message",
    id: "output-item",
    role: "assistant",
    textContent: "response",
  });
  expect(
    rows[0].logs.some(
      (e: any) =>
        e.metadata?.["contrib.livekit.committed_messages"]?.["input-item"],
    ),
  ).toBe(true);
  expect(
    rows[1].logs.some(
      (e: any) =>
        e.metadata?.["contrib.livekit.committed_messages"]?.["input-item"],
    ),
  ).toBe(false);
  expect(
    rows[1].logs.some(
      (e: any) =>
        e.metadata?.["contrib.livekit.committed_messages"]?.["output-item"],
    ),
  ).toBe(true);
  p.onEnd(turn);
  p.onEnd(root);
});
test("pipeline context owns an interrupted message after the speech handle is cleared", () => {
  const { rows, span, p } = fixture(true),
    root = span("root", "agent_session"),
    turn = span("turn", "agent_turn", "root");
  p.onStart(root);
  p.onStart(turn);
  p.onEnd(turn);
  p.scope(turn, () =>
    p.conversation(
      { sessionSpan: root },
      {
        type: "message",
        id: "interrupted-item",
        role: "assistant",
        textContent: "partial response",
        interrupted: true,
      },
    ),
  );
  expect(
    rows[1].logs.some(
      (event: any) =>
        event.metadata?.["contrib.livekit.committed_messages"]?.[
          "interrupted-item"
        ]?.turn_span_id === "1",
    ),
  ).toBe(true);
  p.onEnd(root);
});

test("realtime speaking nests under its provider turn without crossing sessions or dispatches", async () => {
  const { rows, span, p } = fixture(true);
  const root = span("root", "agent_session"),
    other = span("other", "agent_session");
  p.onStart(root);
  p.onStart(other);
  const provider = new EventEmitter();
  p.realtime({
    agentSession: { sessionSpan: root },
    realtimeSession: provider,
  });
  provider.emit("openai_server_event_received", {
    type: "input_audio_buffer.speech_started",
    item_id: "caller-item",
  });
  const user = rows.find((row) => row.args.name === "user_turn")!;
  const unrelated = span("unrelated", "user_speaking", "other");
  const speaking = span("speaking", "user_speaking", "root");
  p.onStart(unrelated);
  p.onStart(speaking);
  expect(rows.at(-2)?.parent).toBe(rows[1].spanId);
  expect(rows.at(-1)?.parent).toBe(user.spanId);
  expect(rows.at(-1)?.logs).toContainEqual({
    metadata: {
      "turn.id": user.spanId,
      "contrib.livekit.turn.association": "provider_speech_start_dispatch",
    },
  });
  p.onEnd(speaking);
  p.onEnd(unrelated);
  provider.emit("openai_server_event_received", {
    type: "input_audio_buffer.speech_started",
    item_id: "later-item",
  });
  await Promise.resolve();
  const delayed = span("delayed", "user_speaking", "root");
  p.onStart(delayed);
  expect(rows.at(-1)?.parent).toBe(rows[0].spanId);
  p.onEnd(delayed);
  p.onEnd(other);
  p.onEnd(root);
});

test("inference suppression preserves results and leaves provider calls in user tools visible", async () => {
  const { rows, span, p } = fixture(true);
  const root = span("root", "agent_session");
  const turn = span("turn", "agent_turn", "root");
  p.onStart(root);
  p.onStart(turn);
  const channels = defineChannels(
    "livekit-test-provider",
    {
      request: channel<[], string>({ channelName: "request", kind: "async" }),
    },
    { instrumentationName: "openai" },
  );
  const unsubscribe = traceAsyncChannel(channels.request, {
    name: "provider-request",
    type: "llm",
    extractInput: () => ({ input: "request", metadata: undefined }),
    extractOutput: (value) => value,
    extractMetrics: () => ({}),
  });
  try {
    const request = () =>
      channels.request.tracePromise(async () => "answer", { arguments: [] });
    await p.scope(turn, async () => {
      expect(
        await p.inference(async () => {
          await Promise.resolve();
          return request();
        }),
      ).toBe("answer");
      expect(await request()).toBe("answer"); // e.g. a provider call inside a user tool
    });
    expect(
      rows.filter((row) => row.args.name === "provider-request"),
    ).toHaveLength(1);
  } finally {
    unsubscribe();
  }
  p.onEnd(turn);
  p.onEnd(root);
});

test("common voice operations expose standard messages, metrics, and native provenance", () => {
  const { rows, span, p } = fixture(true);
  const root = span("s", "agent_session");
  const user = span("u", "user_turn", "s", {
    "lk.pii.user_transcript": "Where is order 1042?",
  });
  const turn = span("a", "agent_turn", "s");
  const model = span("m", "llm_node", "a", {
    "gen_ai.request.model": "gpt-4.1-nano",
    "gen_ai.provider.name": "openai",
    "gen_ai.usage.input_tokens": 10,
    "gen_ai.usage.output_tokens": 3,
    "lk.response.ttft": 0.2,
    "gen_ai.output.messages": JSON.stringify([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: "call-1",
            name: "lookup_order",
            arguments: { order_id: "1042" },
          },
        ],
      },
    ]),
  });
  for (const s of [root, user, turn, model]) p.onStart(s);
  for (const s of [model, user, turn, root]) p.onEnd(s);
  expect(rows.map((r) => r.args.name)).toEqual([
    "livekit.agent_session",
    "user_turn",
    "assistant_turn",
    "llm_response",
  ]);
  expect(
    rows[1].logs.some((e) => e.input?.[0]?.content === "Where is order 1042?"),
  ).toBe(true);
  expect(
    rows[3].logs.some(
      (e) => e.metrics?.tokens === 13 && e.metrics?.time_to_first_token === 0.2,
    ),
  ).toBe(true);
  expect(rows[3].logs.some((e) => e.metadata?.model === "gpt-4.1-nano")).toBe(
    true,
  );
  expect(
    rows[3].logs.some((e) => e.output?.[0]?.tool_calls?.[0]?.id === "call-1"),
  ).toBe(true);
  expect(
    rows[3].logs.some((e) => e.metadata?.["turn.id"] === rows[2].spanId),
  ).toBe(true);
});
test("content opt-out also excludes system instructions and tool definitions", () => {
  const { rows, span, p } = fixture(false);
  const root = span("s", "agent_session");
  const model = span("m", "llm_node", "s", {
    "gen_ai.system_instructions": "private instructions",
    "gen_ai.tool.definitions": "private definitions",
  });
  p.onStart(root);
  p.onStart(model);
  p.onEnd(model);
  p.onEnd(root);
  expect(JSON.stringify(rows)).not.toContain("private");
});

test("tool-only cascade turns expose tool requests in standard output", () => {
  const { rows, span, p } = fixture(true);
  const root = span("s", "agent_session"),
    turn = span("a", "agent_turn", "s"),
    model = span("m", "llm_node", "a", {
      "gen_ai.output.messages": JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "call-1",
              name: "lookup_order",
              arguments: { order_id: "1042" },
            },
          ],
        },
      ]),
    });
  for (const s of [root, turn, model]) p.onStart(s);
  for (const s of [model, turn, root]) p.onEnd(s);
  expect(
    rows[1].logs.some((e) => e.output?.[0]?.tool_calls?.[0]?.id === "call-1"),
  ).toBe(true);
});

test("upload failure corrects recording descriptors and selections even when logger flush resolves", async () => {
  // Exporter-level tests cover rejection/status propagation; this checks wiring.
  // Exercise real encoding/export without requiring a built worker in core tests.
  const encoder = vi
    .spyOn(audioWorker, "createEncoder")
    .mockReturnValue(async (packets, durationMs) => ({
      ...encodeCall(packets, durationMs),
      mimeType: "audio/wav",
      sampleRate: 24000,
    }));
  const resolve = audioOptions.resolveAudioOptions;
  const load = vi
    .spyOn(audioOptions, "resolveAudioOptions")
    .mockImplementation((options) => resolve(options, () => audioExtension));
  const upload = vi.spyOn(Attachment.prototype, "upload").mockResolvedValue({
    upload_status: "error",
    error_message: "upload unavailable",
  });
  try {
    const { p, rows, span } = fixture(false, { captureUserAudio: true });
    const root = span("session", "agent_session"),
      turn = span("user", "user_turn", "session");
    p.onStart(root);
    p.onStart(turn);
    const session = { sessionSpan: root },
      activity = { agentSession: session };
    p.begin(session);
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({
          data: new Int16Array(480).fill(1234),
          sampleRate: 24000,
          channels: 1,
        });
        controller.close();
      },
    });
    p.input(activity, source);
    const reader = source.getReader();
    await reader.read();
    reader.releaseLock();
    p.userTurn(activity, {
      userTurnSpan: turn,
      startedSpeakingAt: Date.now() - 1000,
      stoppedSpeakingAt: Date.now() + 1000,
    });
    p.onEnd(turn);
    p.onEnd(root);
    await p.forceFlush();
    const descriptors = rows[0].logs
      .filter((event) => event.metadata?.["audio.recordings"])
      .at(-1).metadata["audio.recordings"];
    expect(descriptors).toContainEqual(
      expect.objectContaining({
        id: "call-0000",
        state: "omitted",
        reason: "recording_export_failed",
      }),
    );
    expect(
      rows[1].logs
        .filter((event) => event.metadata?.["audio.selections"])
        .at(-1).metadata["audio.selections"],
    ).toEqual([]);
    expect(upload).toHaveBeenCalledTimes(1);
  } finally {
    upload.mockRestore();
    load.mockRestore();
    encoder.mockRestore();
  }
});

test("failed shutdown flush still releases the runtime for another processor", async () => {
  const failure = new Error("export unavailable");
  fixture(false, {
    logger: {
      flush: async () => {
        throw failure;
      },
    } as any,
  });
  const failed = processor!;
  processor = undefined;
  await expect(failed.shutdown()).rejects.toBe(failure);
  expect(() => fixture()).not.toThrow();
});
