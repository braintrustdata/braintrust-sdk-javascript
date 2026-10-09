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
          end(event: { endTime?: number } = {}) {
            row.end ??= { endTime: event.endTime ?? Date.now() / 1000 };
            return row.end.endTime;
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
  const laterChild = span("later", "agent_turn", "b");
  p.onStart(laterChild);
  p.onEnd(laterChild);
  p.onEnd(child);
  p.onEnd(b);
  expect(rows[3].parent).toBe(rows[1].spanId);
  expect(rows[3].end).toEqual({ endTime: 2 });
  expect(rows[1].end).toEqual({ endTime: 2 });
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
  expect(rows[2].end).toBeUndefined();
  p.onEnd(tool);
  expect(rows[2].logs.find((event: any) => event.output)?.output).toEqual({
    ok: true,
  });
  expect(rows[2].parent).toBe("1");
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

test("realtime speaking nests under its framework turn without crossing sessions or dispatches", async () => {
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
  provider.emit("input_speech_started", {});
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
      "contrib.livekit.turn.association": "realtime_speech_start_dispatch",
    },
  });
  p.onEnd(speaking);
  p.onEnd(unrelated);
  provider.emit("input_speech_stopped", {});
  provider.emit("input_speech_started", {});
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

test("duplex generation content comes from LiveKit streams without provider events", async () => {
  const { rows, span, p } = fixture(true);
  const root = span("root", "agent_session");
  const turn = span("turn", "agent_turn", "root");
  const inference = span("model", "realtime_inference", "turn");
  for (const native of [root, turn, inference]) p.onStart(native);
  const session = Object.assign(new EventEmitter(), {
    chatCtx: {
      items: [
        {
          type: "message",
          id: "user",
          role: "user",
          content: ["Where is order 1042?"],
        },
      ],
    },
  });
  const stream = <T>(items: T[]) =>
    new ReadableStream<T>({
      start(c) {
        for (const item of items) c.enqueue(item);
        c.close();
      },
    });
  const textStream = stream(["It arrives ", "Friday."]);
  const ev = {
    responseId: "native-response",
    messageStream: stream([{ messageId: "answer", textStream }]),
    functionStream: stream([
      {
        type: "function_call",
        callId: "call",
        name: "lookup_order",
        args: '{"order_id":"1042"}',
      },
    ]),
  };
  p.realtime(
    { agentSession: { sessionSpan: root }, realtimeSession: session },
    { ev, inferenceSpan: inference, span: turn },
  );
  expect(textStream.locked).toBe(false);
  const consumed: string[] = [];
  await ev.messageStream.pipeTo(
    new WritableStream({
      async write(message) {
        await message.textStream.pipeTo(
          new WritableStream({
            write(text) {
              consumed.push(text);
            },
          }),
        );
      },
    }),
  );
  expect(consumed).toEqual(["It arrives ", "Friday."]);
  await ev.functionStream.pipeTo(new WritableStream());
  p.onEnd(inference);
  expect(rows[2].logs).toContainEqual(
    expect.objectContaining({
      input: [{ role: "user", content: "Where is order 1042?" }],
    }),
  );
  expect(rows[2].logs).toContainEqual({
    output: [{ role: "assistant", content: "It arrives Friday." }],
  });
  expect(
    rows[2].logs.some((e: any) =>
      e.output?.some((m: any) => m.tool_calls?.[0]?.id === "call"),
    ),
  ).toBe(true);
  p.onEnd(turn);
  p.onEnd(root);
});

test("installing a realtime observer never hides a native caller turn", () => {
  const { rows, span, p } = fixture();
  const root = span("root", "agent_session");
  p.onStart(root);
  p.realtime({
    agentSession: { sessionSpan: root },
    realtimeSession: new EventEmitter(),
  });
  const user = span("user", "user_turn", "root");
  p.onStart(user);
  p.onEnd(user);
  expect(rows[1].args.name).toBe("user_turn");
  expect(JSON.stringify(rows[1])).not.toContain("input_observation");
  p.onEnd(root);
});

test("committed realtime fragments preserve the complete caller turn and speaking parents", () => {
  const { rows, span, p } = fixture(true);
  const root = span("root", "agent_session");
  p.onStart(root);
  const provider = new EventEmitter();
  const session = { sessionSpan: root };
  p.realtime({ agentSession: session, realtimeSession: provider });
  for (const [id, text] of [
    ["a", "Where is my order"],
    ["b", " DMO"],
    ["c", "1042?"],
  ]) {
    provider.emit("input_speech_started", {});
    const speaking = span(id, "user_speaking", "root");
    p.onStart(speaking);
    provider.emit("input_audio_transcription_completed", {
      itemId: id,
      transcript: text,
      isFinal: true,
    });
    p.conversation(session, {
      type: "message",
      id,
      role: "user",
      textContent: text,
      interrupted: false,
    });
    p.onEnd(speaking);
    provider.emit("input_speech_stopped", {});
  }
  const callers = rows.filter((row) => row.args.name === "user_turn");
  expect(callers).toHaveLength(1);
  expect(callers[0].logs.filter((event) => event.input).at(-1).input).toEqual([
    { role: "user", content: "Where is my order DMO1042?" },
  ]);
  const speech = rows.filter(
    (row) => row.args.name === "livekit.user_speaking",
  );
  expect(speech).toHaveLength(3);
  expect(speech.every((row) => row.parent === callers[0].spanId)).toBe(true);
  p.onEnd(root);
});

test("late native realtime metrics update their model operation without another span", () => {
  const { rows, span, p } = fixture();
  const root = span("s", "agent_session");
  const model = span("m", "realtime_inference", "s");
  const late = span("late", "realtime_metrics", "m", {
    "gen_ai.response.id": "response-1",
    "gen_ai.usage.input_tokens": 10,
    "gen_ai.usage.output_tokens": 3,
  });
  p.onStart(root);
  p.onStart(model);
  p.onEnd(model);
  p.onStart(late);
  p.onEnd(late);
  expect(rows).toHaveLength(2);
  expect(rows[1].logs).toContainEqual(
    expect.objectContaining({
      metrics: expect.objectContaining({
        prompt_tokens: 10,
        completion_tokens: 3,
        tokens: 13,
      }),
      metadata: expect.objectContaining({ "gen_ai.response.id": "response-1" }),
    }),
  );
});

test("early native realtime usage reaches its inference with content capture disabled", () => {
  const { rows, span, p } = fixture(false);
  const root = span("root", "agent_session");
  const session = { sessionSpan: root } as any;
  const realtimeSession = new EventEmitter();
  const activity = { agentSession: session, realtimeSession } as any;
  p.onStart(root);
  p.realtime(activity);
  realtimeSession.emit("metrics_collected", {
    type: "realtime_model_metrics",
    requestId: "response",
    inputTokens: 10,
    outputTokens: 2,
    transcript: "must not be logged",
  });
  const inference = span("model", "realtime_inference", "root");
  p.onStart(inference);
  p.realtime(activity, {
    inferenceSpan: inference,
    ev: { responseId: "response" },
  } as any);
  p.onEnd(inference);
  expect(rows[1].logs).toContainEqual(
    expect.objectContaining({
      metrics: { prompt_tokens: 10, completion_tokens: 2, tokens: 12 },
    }),
  );
  expect(JSON.stringify(rows)).not.toContain("must not be logged");
  p.onEnd(root);
});
