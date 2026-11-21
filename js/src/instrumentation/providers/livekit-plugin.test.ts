/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { EventEmitter } from "node:events";
import { z } from "zod/v3";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "../../wrappers/anthropic";
import { wrapOpenAI } from "../../wrappers/oai";
import { currentSpan } from "../../logger/core";
import { configureNode } from "../../node/config";
import { Attachment, SpanImpl, initLogger } from "../../logger/core";
import { _exportsForTestingOnly as logging } from "../../logger/testing";
import type { LiveKitSpan, SpanTime } from "../../vendor-sdk-types/livekit";
import type { AudioMiddleware } from "../../audio-middleware";
import { DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES } from "../config";
import { channel, defineInterceptor } from "../core/interceptor-definitions";
import { traceAsyncCall } from "../core/tracing";
import { _exportsForTestingOnly } from "./livekit-plugin";
import { recordLiveKitOpenAIClient } from "./livekit-client-ownership";
import { livekitChannels } from "./livekit-interceptors";

configureNode();
const { LiveKitTracing, Recording, requestMetadata } = _exportsForTestingOnly;

let logger: ReturnType<typeof logging.useTestBackgroundLogger>;
let tracing: InstanceType<typeof LiveKitTracing>;
let uploads: Uint8Array[];
let now: number;

beforeAll(() => logging.simulateLoginForTests());
beforeEach(() => {
  logger = logging.useTestBackgroundLogger();
  initLogger({
    projectName: "tmp-luca-livekit-unit",
    projectId: "test-project-id",
  });
  vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "");
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  uploads = [];
  vi.spyOn(Attachment.prototype, "upload").mockImplementation(async function (
    this: Attachment,
  ) {
    uploads.push(new Uint8Array(await (await this.data()).arrayBuffer()));
    return { upload_status: "done" };
  });
  tracing = new LiveKitTracing(DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES);
});
afterEach(async () => {
  await tracing.shutdown();
  logging.clearTestBackgroundLogger();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type NativeSpan = ReturnType<typeof nativeSpan>;
function nativeSpan(): LiveKitSpan {
  return {
    spanContext: () => ({ spanId: "0000000000000000" }),
    isRecording: () => false,
    setAttribute() {
      return this;
    },
    setAttributes() {
      return this;
    },
    setStatus() {
      return this;
    },
    addEvent() {
      return this;
    },
    recordException() {},
    end: vi.fn<(time?: SpanTime) => void>(),
  };
}
/** Starts a native span the way LiveKit's tracer reports it. */
function start(
  name: string,
  parent?: NativeSpan,
  attributes: Record<string, unknown> = {},
  startTime: SpanTime = [1, 0],
) {
  const span = nativeSpan();
  tracing.observeSpan(span, {
    name,
    attributes,
    startTime,
    ...(parent ? { context: { getValue: () => parent } } : {}),
  });
  return span;
}
/** Synthetic lifecycle fixtures, independently observed VAD then native wait. */
function vadWait(parent: NativeSpan, at: number, recognition: any = {}) {
  tracing.speechEnd(
    { agentSession: {}, audioRecognition: recognition },
    {
      type: 2,
      silenceDuration: now - at,
      inferenceDuration: 0,
    },
  );
  const wait = start("eou_wait", parent, { "lk.eou.source": "vad" }, at);
  const rearm = (anchor = at, trigger = "vad") =>
    tracing.eouWait(recognition, wait, {
      lastSpeakingTime: anchor,
      trigger,
      endpointingDelay: 500,
    });
  rearm();
  return { wait, rearm, recognition };
}
async function rows() {
  const all = (await logger.drain()) as any[];
  const named = (name: string) =>
    all.filter((row) => row.span_attributes?.name === name);
  return {
    all,
    named,
    one(name: string) {
      const matches = named(name);
      expect(matches, name).toHaveLength(1);
      return matches[0];
    },
  };
}
const frame = (samples = 480, value = 1234) => ({
  data: new Int16Array(samples).fill(value),
  sampleRate: 24000,
  channels: 1,
});
const SESSION_SOURCES = {
  "session-input": { label: "Agent input audio" },
  "agent-output": { label: "Agent audio" },
};
/** A session span's `audio.*` metadata, keyed without the prefix. */
const audioOf = (metadata: any) =>
  Object.fromEntries(
    Object.entries(metadata ?? {})
      .filter(([key]) => key.startsWith("audio."))
      .map(([key, value]) => [key.slice("audio.".length), value]),
  ) as any;
/** Segments of a session's audio, in recording order. */
const segmentsOf = (audio: any) =>
  Object.entries(audio?.segments ?? {})
    .map(([id, segment]: [string, any]) => ({ id, ...segment }))
    .sort((a, b) => a.start_offset_ms - b.start_offset_ms);
/** A span's `audio.selections`: [start, end] in ms, in timeline order. */
const selectionsOf = (row: any) =>
  Object.values(row?.metadata?.["audio.selections"] ?? {})
    .map((s: any) => [s.start_offset_ms, s.end_offset_ms])
    .sort((a: any, b: any) => a[0] - b[0]);
const channelSamples = (bytes: Uint8Array, channel: number) => {
  const view = new DataView(bytes.buffer);
  return Array.from({ length: bytes.length / 4 }, (_, i) =>
    view.getInt16((i * 2 + channel) * 2, true),
  );
};

describe("tracing", () => {
  test("model wrappers own duration only", async () => {
    const root = start("agent_session");
    const model = start("llm_node", root, {
      "lk.response.ttft": 0.1,
      "gen_ai.usage.input_tokens": 10,
    });
    model.end();
    const row = (await rows()).one("llm_response");
    expect(row.span_attributes.type).toBe("task");
    expect(row.metrics.prompt_tokens).toBeUndefined();
    expect(row.metrics.time_to_first_token).toBeUndefined();
    expect(row.metadata["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(row.metadata["contrib.livekit.response.ttft"]).toBeUndefined();
  });
  test("final-only transcript observation is a receipt", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    tracing.stt(
      { userTurnSpan: user },
      {
        type: 2,
        createdAt: 2000,
        alternatives: [{ text: "hello" }],
      },
    );
    const captured = await rows();
    expect(captured.named("stt")).toHaveLength(0);
    expect(captured.one("transcript_received").metrics).toMatchObject({
      start: 2,
      end: 2,
    });
  });

  test("maps a voice conversation to standard spans, messages, metrics and turn links", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    const agent = tracing.scope(user, () => start("agent_turn", root));
    const model = start("llm_node", agent, {
      "lk.pii.chat_ctx": JSON.stringify({
        items: [
          { type: "message", id: "m1", role: "user", content: ["Order 1042?"] },
          { type: "function_call_output", call_id: "old", output: "Sunday" },
        ],
      }),
      "gen_ai.request.model": "gpt-4.1-nano",
      "gen_ai.provider.name": "openai",
      "gen_ai.system_instructions": "private instructions",
      "lk.response.ttft": 0.2,
      "lk.pii.response.text": "",
      "lk.pii.response.function_calls": JSON.stringify([
        { call_id: "call-1", name: "lookup_order", arguments: '{"id":1042}' },
      ]),
    });
    // Native requests fold into the operation wrapper without copying usage.
    const request = start("llm_request", model, {
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 3,
    });
    // Attempts export under the wrapper. A retried attempt's failure does
    // not fail the model response.
    const failed = start("llm_request_run", request, { "lk.retry_count": 0 });
    failed.recordException(new Error("timed out"));
    failed.end([1, 500_000_000]);
    start(
      "llm_request_run",
      request,
      { "lk.retry_count": 1 },
      [1, 500_000_000],
    ).end([2, 0]);
    request.end([2, 0]);
    model.end([2, 0]);
    // Requests owned by other features don't report usage on their exported ancestor.
    start("llm_request", start("keyterm_detection", agent), {
      "gen_ai.request.model": "keyterm-model",
      "gen_ai.usage.input_tokens": 99,
    }).end([2, 0]);
    const tool = start("function_tool", agent, {
      "lk.function_tool.name": "lookup_order",
      "lk.pii.function_tool.arguments": '{"id":1042}',
      "lk.pii.function_tool.output": '{"delivery":"Friday"}',
    });
    const tts = start("tts_node", agent, {
      "lk.pii.input_text": "It arrives Friday.",
    });
    for (const span of [tool, tts, agent, user, root]) span.end([3, 0]);

    const { all, named, one } = await rows();
    expect(all.map((r) => r.span_attributes.name).sort()).toEqual([
      "agent_turn",
      "livekit.keyterm_detection",
      "livekit.llm_request_run",
      "livekit.llm_request_run",
      "llm_response",
      "lookup_order",
      "session",
      "tts",
      "user_turn",
    ]);
    const [session, userTurn, agentTurn] = [
      "session",
      "user_turn",
      "agent_turn",
    ].map(one);
    expect(userTurn.span_parents).toEqual([session.span_id]);
    expect(agentTurn.span_parents).toEqual([session.span_id]);
    expect(agentTurn.metadata).toMatchObject({
      "turn.id": agentTurn.span_id,
      "turn.reply_to": userTurn.span_id,
    });
    expect(agentTurn.metadata.model).toBeUndefined();
    expect(agentTurn.metrics.prompt_tokens).toBeUndefined();
    expect(one("livekit.keyterm_detection").metrics.prompt_tokens).toBe(
      undefined,
    );
    const llm = one("llm_response");
    expect(llm).toMatchObject({
      span_parents: [agentTurn.span_id],
      span_attributes: { type: "task" },
      input: [
        { role: "user", content: "Order 1042?" },
        { role: "tool", content: "Sunday", tool_call_id: "old" },
      ],
      output: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup_order", arguments: '{"id":1042}' },
            },
          ],
        },
      ],
      metrics: {
        start: 1,
        end: 2,
      },
      metadata: {
        model: "gpt-4.1-nano",
        provider: "openai",
        "turn.id": agentTurn.span_id,
        "turn.reply_to": userTurn.span_id,
      },
    });
    expect(llm.error).toBeUndefined();
    const attempts = named("livekit.llm_request_run");
    expect(attempts).toMatchObject([
      {
        span_parents: [llm.span_id],
        span_attributes: { type: "task" },
        error: expect.stringContaining("timed out"),
        metadata: { "contrib.livekit.retry_count": 0 },
        metrics: { start: 1, end: 1.5 },
      },
      {
        span_parents: [llm.span_id],
        metadata: { "contrib.livekit.retry_count": 1 },
        metrics: { start: 1.5, end: 2 },
      },
    ]);
    expect(attempts[1].error).toBeUndefined();
    expect(JSON.stringify(llm.metadata)).not.toContain("private");
    expect(one("lookup_order")).toMatchObject({
      span_attributes: { type: "tool" },
      input: { id: 1042 },
      output: { delivery: "Friday" },
    });
    expect(one("tts")).toMatchObject({
      input: { text: "It arrives Friday." },
      output: [{ role: "assistant", content: "It arrives Friday." }],
    });
  });

  test("links requests, tool results, transcribed context and generated speech", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    const caller = start("user_speaking", user);
    const recognition = {
      userTurnSpan: user,
      sttModel: "gpt-4o-mini-transcribe",
      sttProvider: "openai",
    };
    tracing.stt(recognition, {
      type: 2,
      alternatives: [{ text: "Order?", confidence: 0.9 }],
      requestId: "req-1",
    });
    tracing.stt(recognition, { type: 1, alternatives: [{ text: "interim" }] });
    tracing.stt(recognition, { type: 2, alternatives: [{ text: "1042." }] });
    caller.end();
    const session = { sessionSpan: root };
    tracing.userTurn(
      { agentSession: session },
      { userTurnSpan: user, startedSpeakingAt: 1000, stoppedSpeakingAt: 2000 },
    );
    user.end();
    // The committed message is the turn's transcript, keyed by its native start.
    tracing.conversation(session, {
      type: "message",
      id: "caller",
      role: "user",
      textContent: "Order? 1042.",
      metrics: { startedSpeakingAt: 1 },
    });
    const turn = start("agent_turn", root);
    const model = start("llm_node", turn, {
      "lk.pii.chat_ctx": JSON.stringify({
        items: [
          { type: "message", id: "caller", role: "user", content: ["Order?"] },
        ],
      }),
      "lk.pii.response.function_calls": JSON.stringify([
        { call_id: "call", name: "lookup_order" },
      ]),
    });
    model.end();
    const tool = start("function_tool", turn, {
      "lk.function_tool.name": "lookup_order",
      "gen_ai.tool.call.id": "call",
    });
    tool.end();
    let continuation!: NativeSpan;
    tracing.scope(turn, () => {
      {
        continuation = start("llm_node", turn, {
          "lk.pii.chat_ctx": JSON.stringify({
            items: [
              {
                type: "function_call_output",
                call_id: "call",
                output: "Friday",
              },
            ],
          }),
        });
      }
      // Created after the continuation started in this scope, so it generated them.
      start("tts_node", turn).end();
      const speech = start("agent_speaking", turn);
      tracing.conversation(
        { sessionSpan: root },
        {
          type: "message",
          id: "answer",
          role: "assistant",
          textContent: "Friday",
        },
      );
      speech.end();
    });
    continuation.end();
    const { named, one } = await rows();
    const link = (target: any, type: string) => ({
      context: {
        traceId: target.root_span_id,
        spanId: target.span_id,
        traceFlags: 1,
      },
      attributes: { "braintrust.relationship.type": type },
    });
    const [first, second] = named("llm_response");
    const [stt, rest] = named("transcript_received");
    expect(stt).toMatchObject({
      span_parents: [one("user_turn").span_id],
      output: [{ role: "user", content: "Order?" }],
      metadata: {
        model: "gpt-4o-mini-transcribe",
        provider: "openai",
        "contrib.livekit.transcript_confidence": 0.9,
        "contrib.livekit.provider_request_id": "req-1",
        "turn.id": one("user_turn").span_id,
      },
    });
    // LiveKit doesn't relate transcripts to speech intervals; no link guesses one.
    expect(stt.metadata.links).toBeUndefined();
    expect(one("user_speech").metadata.links).toBeUndefined();
    expect(one("user_speech").input).toBeUndefined();
    expect(first.metadata.links).toEqual([
      link(stt, "uses_context"),
      link(rest, "uses_context"),
    ]);
    expect(one("lookup_order").metadata.links).toEqual([
      link(first, "requested_by"),
    ]);
    expect(second.metadata.links).toEqual([
      link(one("lookup_order"), "consumes_tool_result"),
    ]);
    expect(one("tts").metadata.links).toEqual([link(second, "generated_by")]);
    // The synthesis produced the played audio.
    expect(one("agent_speech")).toMatchObject({
      output: [{ role: "assistant", content: "Friday" }],
      metadata: {
        "contrib.livekit.message_ids": ["answer"],
        links: [link(one("tts"), "generated_by")],
      },
    });
  });

  test("a model response publishes the links from its context once, and again for a late target", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const tool = (callId: string) =>
      start("function_tool", turn, {
        "lk.function_tool.name": "lookup_order",
        "gen_ai.tool.call.id": callId,
      }).end();
    for (const callId of ["call-1", "call-2", "call-3"]) tool(callId);
    const log = vi.spyOn(SpanImpl.prototype, "log");
    const publications = () =>
      log.mock.calls.filter(([event]) => event.metadata?.links).length;
    start("llm_node", turn, {
      "lk.pii.chat_ctx": JSON.stringify({
        items: ["call-1", "call-2", "call-3", "call-4"].map((call_id) => ({
          type: "function_call_output",
          call_id,
        })),
      }),
    }).end();
    expect(publications()).toBe(1);
    tool("call-4");
    expect(publications()).toBe(2);
    turn.end();
    const { one, named } = await rows();
    expect(
      one("llm_response").metadata.links.map((l: any) => l.context.spanId),
    ).toEqual(named("lookup_order").map((r) => r.span_id));
  });

  test("speech is generated by every synthesis in its reply, and only its reply", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    // A reply whose text the app splits into segments: one synthesis each.
    tracing.scope(turn, () => {
      start("llm_node", turn).end();
      start("tts_node", turn, { "lk.name": "first" }).end();
      // A short first segment can finish before the speech starts playing.
      start("tts_node", turn, { "lk.name": "second" }).end();
      const speaking = start("agent_speaking", turn);
      start("tts_node", turn, { "lk.name": "third" }).end();
      speaking.end();
    });
    // A later reply in the same turn, such as after a tool call.
    tracing.scope(turn, () => {
      start("llm_node", turn).end();
      start("tts_node", turn, { "lk.name": "answer" }).end();
      start("agent_speaking", turn).end();
    });
    turn.end();
    const { named } = await rows();
    const tts = named("tts").map((r) => r.span_id);
    const targets = (row: any) =>
      row.metadata.links
        .filter(
          (l: any) =>
            l.attributes["braintrust.relationship.type"] === "generated_by",
        )
        .map((l: any) => l.context.spanId);
    const [first, second] = named("agent_speech");
    expect(targets(first)).toEqual(tts.slice(0, 3));
    expect(targets(second)).toEqual([tts[3]]);
  });

  test("speech without synthesis is generated by its model response", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    tracing.scope(turn, () => {
      start("llm_node", turn).end();
      start("agent_speaking", turn).end();
    });
    const { one } = await rows();
    expect(one("agent_speech").metadata.links).toMatchObject([
      {
        context: { spanId: one("llm_response").span_id },
        attributes: { "braintrust.relationship.type": "generated_by" },
      },
    ]);
  });

  test("llm spans record the tools available to their pipeline reply", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const lookup = {
      description: "Look up an order",
      parameters: z.object({ id: z.number() }),
    };
    const reply = (request: Parameters<typeof requestMetadata>[0]) =>
      tracing.scope(
        turn,
        () => start("llm_node", turn).end(),
        requestMetadata(request),
      );
    reply({
      span: turn,
      toolCtx: {
        functionTools: {
          lookup_order: lookup,
          cancel_order: {
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
            },
          },
        },
      },
      modelSettings: { toolChoice: "required" },
    });
    // A later reply in the same turn can change its tools.
    reply({ span: turn, toolCtx: { functionTools: {} } });
    turn.end();
    root.end();

    const [first, second] = (await rows()).named("llm_response");
    expect(first.metadata).toMatchObject({
      tool_choice: "required",
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_order",
            description: "Look up an order",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "cancel_order",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
            },
          },
        },
      ],
    });
    expect(second.metadata.tools).toBeUndefined();
    expect(second.metadata.tool_choice).toBeUndefined();
  });

  test.each([
    ["high resolution", [2, 500_000_000] as [number, number]],
    ["milliseconds", 2500],
    ["date", new Date(2500)],
  ])(
    "observes attributes, status and events without changing native spans (%s)",
    async (_name, time) => {
      const root = nativeSpan();
      const context = root.spanContext();
      const end = root.end;
      tracing.observeSpan(root, { name: "agent_session", startTime: time });
      expect(root.isRecording()).toBe(true);
      expect(root.setAttribute("lk.test", "value")).toBe(root);
      expect(root.setAttributes({ "gen_ai.request.model": "test-model" })).toBe(
        root,
      );
      expect(root.setAttribute("__proto__", "safe")).toBe(root);
      expect(root.addEvent("with attributes", { count: 1 }, time)).toBe(root);
      expect(root.addEvent("with timestamp", time)).toBe(root);
      expect(root.setStatus({ code: 2, message: "failed" })).toBe(root);
      // Folded requests outside a model response keep their native recording
      // state, since nothing they record is exported.
      const internal = nativeSpan();
      tracing.observeSpan(internal, {
        name: "llm_request",
        context: { getValue: () => root },
      });
      expect(internal.isRecording()).toBe(false);
      internal.end();
      root.end(time);
      root.end(time);
      expect(end).toHaveBeenCalledTimes(2);
      expect(root.spanContext()).toEqual(context);
      expect(root.isRecording()).toBe(false);
      root.setAttribute("lk.test", "late");
      root.addEvent("late");
      root.recordException(new Error("late"));
      await tracing.closeSession(root);
      expect(tracing.sessions.size).toBe(0);

      const { all } = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        span_attributes: { name: "session" },
        error: "failed",
        metrics: { start: 2.5, end: 2.5 },
        metadata: {
          model: "test-model",
          "contrib.livekit.test": "value",
          "contrib.livekit.events": [
            {
              name: "with attributes",
              time_unix_ms: 2500,
              attributes: { count: 1 },
            },
            { name: "with timestamp", time_unix_ms: 2500, attributes: {} },
          ],
        },
      });
      expect(Object.getPrototypeOf(all[0].metadata)).toBe(Object.prototype);
    },
  );

  test("exports native lifecycle spans under their native parents", async () => {
    const root = start("agent_session");
    const sessionStart = start("session_start", root);
    const activity = start("start_agent_activity", sessionStart, {
      "lk.agent_label": "default_agent",
    });
    start("setup_toolsets", activity).end();
    start("on_enter", activity).end();
    activity.end();
    sessionStart.end();
    const turn = start("user_turn", root);
    const { wait } = vadWait(turn, 1000);
    start("eou_detection", wait, { "lk.eou.probability": 0.9 }).end();
    wait.end();
    turn.end();
    const tts = start("tts_node", root);
    const request = start("tts_request", tts);
    start("tts_request_run", request, { "lk.retry_count": 0 }).end();
    request.end();
    tts.end();
    root.end();

    const { all, one } = await rows();
    const parent = (row: any) =>
      all.find((r) => r.span_id === row.span_parents?.[0])?.span_attributes
        .name;
    expect(
      Object.fromEntries(
        all.map((row) => [row.span_attributes.name, parent(row) ?? null]),
      ),
    ).toEqual({
      session: null,
      "livekit.session_start": "session",
      "livekit.start_agent_activity": "livekit.session_start",
      "livekit.setup_toolsets": "livekit.start_agent_activity",
      "livekit.on_enter": "livekit.start_agent_activity",
      user_turn: "session",
      eou_wait: "user_turn",
      "livekit.eou_detection": "eou_wait",
      tts: "session",
      "livekit.tts_request": "tts",
      "livekit.tts_request_run": "livekit.tts_request",
    });
    expect(one("livekit.start_agent_activity")).toMatchObject({
      span_attributes: { type: "task" },
      metadata: { "contrib.livekit.agent_label": "default_agent" },
    });
    expect(one("livekit.eou_detection").metadata).toMatchObject({
      "contrib.livekit.eou.probability": 0.9,
      "turn.id": one("user_turn").span_id,
    });
  });

  test("event attributes omit content keys", async () => {
    const root = start("agent_session");
    root.addEvent("participant_linked", {
      "lk.participant_kind": "sip",
      "lk.pii.participant_identity": "+15550100",
    });
    root.end();
    const { one } = await rows();
    expect(one("session").metadata["contrib.livekit.events"]).toEqual([
      expect.objectContaining({
        name: "participant_linked",
        attributes: { "contrib.livekit.participant_kind": "sip" },
      }),
    ]);
  });

  test("the span limit applies per session to exported spans", async () => {
    const full = start("agent_session");
    const other = start("agent_session");
    // Folded spans, including ones LiveKit never ends, do not count toward the limit.
    for (let i = 0; i < 10_000; i++) start("llm_request", full);
    for (let i = 2; i < 8192; i++) start("user_turn", full).end();
    // The first turn takes the session's last slot; the second is not traced.
    start("agent_turn", full).end();
    start("agent_turn", full).end();
    start("agent_turn", other).end();
    full.end();
    other.end();
    const { named } = await rows();
    expect(
      named("agent_turn")
        .map((r) => r.span_parents[0])
        .sort(),
    ).toEqual(
      named("session")
        .map((r) => r.span_id)
        .sort(),
    );
  });

  test("leaves spans outside tracked sessions unchanged", async () => {
    const span = nativeSpan();
    const methods = { ...span };
    tracing.observeSpan(span, { name: "job" });
    expect(span).toEqual(methods);
    expect((await rows()).all).toHaveLength(0);
  });

  test("concurrent sessions keep parents separate; closing one does not clear another", async () => {
    const a = start("agent_session");
    const b = start("agent_session");
    const child = start("agent_turn", a);
    a.end([2, 0]);
    const later = start("agent_turn", b);
    later.end([2, 0]);
    child.end([2, 0]);
    b.end([2, 0]);
    const { named } = await rows();
    const [sa, sb] = named("session");
    expect(named("agent_turn").map((r) => r.span_parents)).toEqual([
      [sa.span_id],
      [sb.span_id],
    ]);
  });

  test("late exported children keep session ownership until they end", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const tool = start("function_tool", turn, {
      "lk.function_tool.name": "late_tool",
    });
    // Unfinished waits do not hold the session. Close their exported rows as
    // incomplete when the last outstanding mapped operation ends.
    const wait = start("eou_wait", turn);
    turn.end([2, 0]);
    root.end([2, 0]);
    await tracing.closeSession(root);
    expect(tracing.sessions.size).toBe(1);
    tool.setAttribute("lk.pii.function_tool.output", '{"ok":true}');
    tool.end([3, 0]);
    expect(tracing.sessions.size).toBe(0);
    wait.end([4, 0]);
    const { one } = await rows();
    expect(one("late_tool")).toMatchObject({
      span_parents: [one("agent_turn").span_id],
      output: { ok: true },
    });
    expect(one("livekit.eou_wait")).toMatchObject({
      span_parents: [one("session").span_id],
      metrics: { end: 2 },
      metadata: {
        "contrib.livekit.incomplete": true,
        "contrib.livekit.termination": "session_closed",
      },
    });
  });

  test("sessions inherit the current Braintrust parent", async () => {
    const outer = start("agent_session");
    tracing.scope(outer, () => start("agent_session"));
    const [first, second] = (await rows()).named("session");
    expect(second.span_parents).toEqual([first.span_id]);
  });

  test("inference preserves provider calls and results, including calls inside user tools", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const channels = defineInterceptor("livekit-test-provider", {
      request: channel<[], Promise<string>>({ channelName: "request" }),
    });
    const unsubscribe = channels.request.intercept((target, self, args) =>
      traceAsyncCall<typeof channels.request>(
        () => Reflect.apply(target, self, args),
        { arguments: args },
        {
          instrumentationName: "openai",
          name: "provider-request",
          type: "llm",
          extractInput: () => ({ input: "request", metadata: undefined }),
          extractOutput: (value) => value,
          extractMetrics: () => ({}),
        },
      ),
    );
    try {
      const request = () =>
        channels.request.invoke(async () => "answer", undefined, [], {});
      await tracing.scope(turn, async () => {
        expect(
          await (async () => {
            await Promise.resolve();
            return request();
          })(),
        ).toBe("answer");
        expect(await request()).toBe("answer"); // e.g. a provider call inside a user tool
      });
    } finally {
      unsubscribe();
    }
    expect((await rows()).named("provider-request")).toHaveLength(2);
  });

  test("shutdown ends open spans as incomplete and makes observers inert", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    await tracing.shutdown();
    turn.end();
    start("agent_session").end();
    expect(root.isRecording()).toBe(false);
    const { all, one } = await rows();
    expect(all).toHaveLength(2);
    expect(one("agent_turn").metadata).toMatchObject({
      "turn.incomplete": true,
      "contrib.livekit.termination": "processor_shutdown",
    });
    expect(one("session").metadata).toMatchObject({
      "contrib.livekit.incomplete": true,
    });
  });
});

describe("eou_wait audio schema", () => {
  function pendingRecognition(parent: NativeSpan, at = 2000): any {
    const recognition = {
      userTurnSpan: parent,
      lastSpeakingTime: at,
      vad: {},
      stt: {},
      audioTranscript: "",
      vadBaseTurnDetection: true,
    };
    tracing.speechEnd(
      { agentSession: {}, audioRecognition: recognition },
      {
        type: 2,
        silenceDuration: now - at,
        inferenceDuration: 0,
      },
    );
    return recognition;
  }

  test("a synchronous STT factory is reconciled only after the framework adopts its timestamp", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    now = 2500;
    const recognition: any = { userTurnSpan: turn };
    let wait!: NativeSpan;
    tracing.processSTT(
      recognition,
      { type: 2, speechEndTime: 2000, alternatives: [{ text: "hello" }] },
      () => {
        recognition.lastSpeakingTime = 2000;
        wait = start("eou_wait", turn, {}, 2000);
        tracing.eouWait(recognition, wait, {
          trigger: "stt",
          lastSpeakingTime: 2000,
          endpointingDelay: 0,
        });
      },
    );
    wait.setAttribute("lk.eou.outcome", "committed");
    wait.end(2600);
    const { one, named } = await rows();
    expect(one("eou_wait").metrics).toMatchObject({ start: 2, end: 2.6 });
    expect(named("livekit.eou_wait")).toHaveLength(0);
  });

  test("a transcript-gated pause exports once on resume without any native wait", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    now = 2200;
    const recognition = pendingRecognition(turn);
    tracing.eouEvaluation(recognition);
    tracing.eouEvaluation(recognition);
    tracing.eouEnd(recognition, "user_resumed", 2300);
    tracing.eouEnd(recognition, "user_resumed", 2300);
    turn.end(2400);
    root.end(2400);
    await tracing.closeSession(root);
    const { one, named } = await rows();
    expect(one("eou_wait")).toMatchObject({
      metrics: { start: 2, end: 2.3 },
      span_parents: [one("user_turn").span_id],
      metadata: {
        "eou.outcome": "user_resumed",
        "eou.speech_end_source": "vad",
      },
    });
    expect(one("eou_wait").metadata).not.toHaveProperty(
      "contrib.livekit.eou.native_start_unix_ms",
    );
    expect(named("livekit.eou_wait")).toHaveLength(0);
    expect(tracing.sessions.size).toBe(0);
  });

  test("a later native factory attaches to the pending pause before detector children start", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    now = 2200;
    const recognition = pendingRecognition(turn);
    tracing.eouEvaluation(recognition);
    const wait = tracing.waitFactory(recognition, () =>
      start("eou_wait", turn, { "lk.eou.source": "stt" }, 2100),
    );
    tracing.eouWait(recognition, wait, {
      trigger: "stt",
      lastSpeakingTime: 2000,
      endpointingDelay: 0,
    });
    const detector = start("eou_detection", wait, {}, 2200);
    detector.end(2400);
    wait.setAttribute("lk.eou.outcome", "committed");
    wait.end(2500);
    const { one } = await rows();
    expect(one("eou_wait").metrics).toMatchObject({ start: 2, end: 2.5 });
    expect(one("eou_wait").metadata).toMatchObject({
      "contrib.livekit.eou.native_start_unix_ms": 2100,
      "contrib.livekit.eou.source": "stt",
      "eou.outcome": "committed",
    });
    expect(one("livekit.eou_detection").span_parents).toEqual([
      one("eou_wait").span_id,
    ]);
  });

  test.each([
    "manual",
    "no-stt",
    "has-transcript",
    "invalid-anchor",
    "no-evidence",
    "manual-flush",
  ])(
    "does not invent a transcription-gated wait with %s",
    async (condition) => {
      const root = start("agent_session");
      now = 2200;
      const recognition = pendingRecognition(root);
      if (condition === "manual") recognition.turnDetectionMode = "manual";
      if (condition === "no-stt") recognition.stt = undefined;
      if (condition === "has-transcript") recognition.audioTranscript = "hello";
      if (condition === "invalid-anchor") recognition.lastSpeakingTime = NaN;
      if (condition === "no-evidence")
        tracing.vadSpeech({ agentSession: {}, audioRecognition: recognition });
      if (condition === "manual-flush")
        recognition.sttPipeline = { manualFlush: true };
      tracing.eouEvaluation(recognition);
      tracing.eouEnd(recognition, "user_resumed", 2300);
      expect((await rows()).named("eou_wait")).toHaveLength(0);
    },
  );

  test("a pending pause without turn membership uses the session and shutdown leaves its outcome unknown", async () => {
    const root = start("agent_session");
    now = 2200;
    const recognition = pendingRecognition(root);
    recognition.userTurnSpan = undefined;
    recognition.rootSpanContext = { getValue: () => root };
    tracing.eouEvaluation(recognition);
    tracing.recognitionClose(recognition);
    tracing.eouEnd(recognition, "dropped", 2500);
    root.end(2600);
    await tracing.closeSession(root);
    const { one } = await rows();
    expect(one("eou_wait").span_parents).toEqual([one("session").span_id]);
    expect(one("eou_wait").metadata).not.toHaveProperty("turn.id");
    expect(one("eou_wait").metadata).not.toHaveProperty("eou.outcome");
    expect(one("eou_wait").metadata["contrib.livekit.incomplete"]).toBe(true);
    expect(tracing.sessions.size).toBe(0);
  });

  test.each(["session-close", "processor-shutdown"])(
    "an unfinished pending pause does not hold open %s",
    async (cleanup) => {
      const root = start("agent_session");
      now = 2200;
      const recognition = pendingRecognition(root);
      recognition.userTurnSpan = undefined;
      recognition.rootSpanContext = { getValue: () => root };
      tracing.eouEvaluation(recognition);
      now = 2500;
      if (cleanup === "processor-shutdown") await tracing.shutdown();
      else {
        root.end(2500);
        await tracing.closeSession(root);
      }
      const { one } = await rows();
      expect(one("eou_wait").metrics).toMatchObject({ start: 2, end: 2.5 });
      expect(one("eou_wait").metadata).not.toHaveProperty("eou.outcome");
      expect(one("eou_wait").metadata["contrib.livekit.incomplete"]).toBe(true);
      expect(tracing.sessions.size).toBe(0);
    },
  );

  test("an absolute end on an STT event establishes timing but cannot distinguish provider from VAD-adapter provenance", async () => {
    const root = start("agent_session");
    now = 2500;
    const recognition = { lastSpeakingTime: 2000 };
    tracing.processSTT(
      recognition,
      { type: 2, speechEndTime: 2000, alternatives: [{ text: "hello" }] },
      () => {},
    );
    const wait = start("eou_wait", root, {}, 2000);
    tracing.eouWait(recognition, wait, {
      lastSpeakingTime: 2000,
      trigger: "stt",
      endpointingDelay: 0,
    });
    wait.setAttribute("lk.eou.outcome", "committed");
    wait.end(2600);
    const { one } = await rows();
    expect(one("eou_wait").metrics).toMatchObject({ start: 2, end: 2.6 });
    expect(one("eou_wait").metadata).not.toHaveProperty(
      "eou.speech_end_source",
    );
  });

  test("a failed STT callback preserves the exception and cannot establish anchor provenance", async () => {
    const root = start("agent_session");
    now = 2500;
    const recognition = { lastSpeakingTime: 2000 };
    const error = new Error("callback failed");
    expect(() =>
      tracing.processSTT(
        recognition,
        { type: 2, speechEndTime: 2000, alternatives: [{ text: "hello" }] },
        () => {
          throw error;
        },
      ),
    ).toThrow(error);
    const wait = start("eou_wait", root, {}, 2000);
    tracing.eouWait(recognition, wait, {
      lastSpeakingTime: 2000,
      trigger: "stt",
      endpointingDelay: 0,
    });
    wait.end(2600);
    expect((await rows()).named("eou_wait")).toHaveLength(0);
  });

  test("combined wrapping and auto instrumentation observe an STT invocation only once", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    const recognition = { userTurnSpan: turn };
    const event = { type: 2, alternatives: [{ text: "hello" }] };
    const target = vi.fn(() => "result");
    expect(
      tracing.processSTT(recognition, event, () =>
        tracing.processSTT(recognition, event, target),
      ),
    ).toBe("result");
    expect(target).toHaveBeenCalledTimes(1);
    const captured = await rows();
    expect(captured.named("transcript_received")).toHaveLength(1);
    expect(captured.named("stt")).toHaveLength(0);
  });

  test.each(["dropped", "committed"])(
    "native %s during recognition close requires an actual decision",
    async (outcome) => {
      const root = start("agent_session");
      now = 2200;
      const { wait } = vadWait(root, 2000);
      tracing.recognitionClose({ eouWaitSpan: wait });
      wait.setAttribute("lk.eou.outcome", outcome);
      wait.end(2600);
      const { one } = await rows();
      expect(one("eou_wait").metadata["contrib.livekit.eou.outcome"]).toBe(
        outcome,
      );
      expect(one("eou_wait").metadata["eou.outcome"]).toBe(
        outcome === "committed" ? "committed" : undefined,
      );
      if (outcome === "dropped")
        expect(one("eou_wait").metadata).toMatchObject({
          "contrib.livekit.incomplete": true,
          "contrib.livekit.termination": "recognition_closed",
        });
    },
  );

  test("resume timing survives the diagnostic event cap and requires an explicit timestamp", async () => {
    const root = start("agent_session");
    now = 2200;
    const first = vadWait(root, 2000).wait;
    for (let i = 0; i < 300; i++) first.addEvent("rearmed", {}, 2200);
    first.addEvent("user_resumed", {}, 2300);
    first.setAttribute("lk.eou.outcome", "user_resumed");
    first.end(2600);
    const second = vadWait(root, 2000).wait;
    second.addEvent("user_resumed", {});
    second.setAttribute("lk.eou.outcome", "user_resumed");
    second.end(2600);
    const { one } = await rows();
    expect(one("eou_wait").metrics.end).toBe(2.3);
    expect(
      one("livekit.eou_wait").metadata["contrib.livekit.eou.canonical_omitted"],
    ).toBe("unobserved_wait_end");
  });

  test("an STT evaluation trigger retaining a VAD anchor does not change its provenance", async () => {
    const root = start("agent_session");
    now = 2200;
    const recognition = { vad: {}, lastSpeakingTime: 2000 };
    const { wait, rearm } = vadWait(root, 2000, recognition);
    tracing.processSTT(
      recognition,
      { type: 2, speechEndTime: 2000, alternatives: [{ text: "hello" }] },
      () => {},
    );
    rearm(2000, "stt");
    wait.setAttributes({
      "lk.eou.outcome": "committed",
      "lk.eou.source": "stt",
    });
    wait.end(2500);
    expect((await rows()).one("eou_wait").metadata).toMatchObject({
      "eou.speech_end_source": "vad",
      "contrib.livekit.eou.source": "stt",
    });
  });

  test("VAD provenance uses the exact framework correction even across separate clock reads", async () => {
    const root = start("agent_session");
    now = 2200;
    const { wait, rearm } = vadWait(root, 2000);
    rearm(2001);
    wait.end(2500);
    expect((await rows()).one("eou_wait").metrics.start).toBe(2.001);
  });

  test("VAD speech activity invalidates an earlier pause anchor before another wait", async () => {
    const root = start("agent_session");
    now = 2200;
    const { wait, rearm, recognition } = vadWait(root, 2000);
    tracing.vadSpeech(
      { agentSession: {}, audioRecognition: recognition },
      { rawAccumulatedSpeech: 20 },
    );
    rearm(2100);
    wait.end(2500);
    expect((await rows()).named("eou_wait")).toHaveLength(0);
  });

  test.each([NaN, Infinity, 1900])(
    "invalid native end %s cannot establish a canonical interval",
    async (end) => {
      const root = start("agent_session");
      now = 2200;
      const { wait } = vadWait(root, 2000);
      wait.setAttribute("lk.eou.outcome", "committed");
      wait.end(end);
      expect((await rows()).named("eou_wait")).toHaveLength(0);
    },
  );

  test("commit uses observed VAD timing, owning turn and established audio identities", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root, {
      "lk.participant_id": "PA_caller",
      "lk.participant_kind": "STANDARD",
    });
    now = 2300;
    const { wait } = vadWait(turn, 2000);
    wait.setAttributes({
      "lk.eou.outcome": "committed",
      "lk.eou.source": "stt",
      "lk.eou.endpointing_delay": 0.5,
    });
    wait.end([2, 500_000_000]);
    turn.end(2500);
    root.end(2600);
    const { one } = await rows();
    expect(one("eou_wait")).toMatchObject({
      span_attributes: { name: "eou_wait", type: "task" },
      span_parents: [one("user_turn").span_id],
      metrics: { start: 2, end: 2.5 },
      metadata: {
        "turn.id": one("user_turn").span_id,
        "audio.source_id": "session-input",
        "audio.participant_ids": ["participant-1"],
        "eou.outcome": "committed",
        "eou.speech_end_source": "vad",
        "contrib.livekit.eou.source": "stt",
        "contrib.livekit.eou.endpointing_delay": 0.5,
      },
    });
    expect(one("eou_wait").metadata).not.toHaveProperty("eou.end_reason");
    expect(one("eou_wait").metadata).not.toHaveProperty(
      "eou.detection_methods",
    );
    expect(one("session").metadata["audio.schema.version"]).toBe("3.1.0");
  });

  test("resume then later pause commits; rearms and speculative work do not create or end waits", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    start("user_speaking", turn, {}, 1000).end(2000);
    now = 2200;
    const first = vadWait(turn, 2000);
    first.wait.addEvent("user_resumed", {}, new Date(2300));
    first.wait.setAttribute("lk.eou.outcome", "user_resumed");
    first.wait.end(2300);
    start("user_speaking", turn, {}, 2300).end(3500);
    now = 3600;
    const second = vadWait(turn, 3500);
    for (let i = 0; i < 4; i++) {
      second.wait.addEvent(
        "rearmed",
        { "lk.eou.source": "stt" },
        3600 + i * 10,
      );
      start(
        "eou_detection",
        second.wait,
        { "lk.eou.probability": 0.9 },
        3600 + i * 10,
      ).end(3605 + i * 10);
      second.rearm(3500, "stt");
    }
    const model = start("llm_node", root, {}, 3700);
    second.wait.setAttributes({
      "lk.eou.outcome": "committed",
      "lk.eou.rearm_count": 4,
    });
    second.wait.end(4000);
    model.end(4500);
    turn.end(4000);
    root.end(4500);
    const { named, one } = await rows();
    expect(
      named("eou_wait").map((row) => [
        row.metrics.start,
        row.metrics.end,
        row.metadata["eou.outcome"],
      ]),
    ).toEqual([
      [2, 2.3, "user_resumed"],
      [3.5, 4, "committed"],
    ]);
    expect(named("livekit.eou_wait")).toHaveLength(0);
    expect(one("llm_response").metrics).toMatchObject({ start: 3.7, end: 4.5 });
    expect(named("livekit.eou_detection")).toHaveLength(4);
    expect(
      named("eou_wait").every(
        (row) => row.span_parents[0] === one("user_turn").span_id,
      ),
    ).toBe(true);
    await tracing.closeSession(root);
    expect(tracing.sessions.size).toBe(0);
  });

  test("late STT with multiple native gates corrects the anchor without claiming final gate or a complete method set", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    now = 2200;
    const recognition = {
      inputStartedAt: 1000,
      lastSpeakingTime: 2000,
      vad: {},
      turnDetectionMode: "stt",
    };
    const { wait, rearm } = vadWait(turn, 2000, recognition);
    start(
      "eou_detection",
      wait,
      { "lk.eou.probability": 0.8, "lk.eou.unlikely_threshold": 0.5 },
      2200,
    ).end(2400);
    now = 2800;
    // Real STT-origin end timestamp corrects an earlier VAD anchor. The
    // final's receipt (2.8 s) is deliberately different from speech end (2.1 s).
    const event = { type: 2, alternatives: [{ text: "hello", endTime: 1.1 }] };
    tracing.processSTT(recognition, event, () => {
      recognition.lastSpeakingTime = 2100;
    });
    tracing.stt(
      { ...recognition, userTurnSpan: turn },
      { ...event, createdAt: 2800 },
    );
    rearm(2100, "stt");
    wait.setAttributes({
      "lk.eou.outcome": "committed",
      "lk.eou.source": "stt",
      "lk.eou.endpointing_delay": 0.5,
    });
    wait.end(2900);
    const { one } = await rows();
    expect(one("eou_wait").metrics).toMatchObject({ start: 2.1, end: 2.9 });
    expect(one("eou_wait").metadata).toMatchObject({
      "eou.speech_end_source": "stt",
      "eou.outcome": "committed",
      "contrib.livekit.eou.native_start_unix_ms": 2000,
    });
    expect(one("eou_wait").metadata).not.toHaveProperty("eou.end_reason");
    expect(one("eou_wait").metadata).not.toHaveProperty(
      "eou.detection_methods",
    );
    expect(one("transcript_received").metrics).toMatchObject({
      start: 2.8,
      end: 2.8,
    });
  });

  test("resume event bounds canonical wait while detector cleanup retains its native interval", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    now = 2200;
    const { wait } = vadWait(turn, 2000);
    const detector = start("eou_detection", wait, {}, 2200);
    detector.addEvent("superseded", { "lk.eou.outcome": "user_resumed" }, 2600);
    detector.end(2600);
    wait.addEvent("user_resumed", {}, [2, 300_000_000]);
    wait.setAttributes({
      "lk.eou.outcome": "user_resumed",
      "lk.eou.wait_duration": 0.6,
    });
    wait.end(2600);
    const { one } = await rows();
    expect(one("eou_wait").metrics).toMatchObject({ start: 2, end: 2.3 });
    expect(one("livekit.eou_detection")).toMatchObject({
      span_parents: [one("eou_wait").span_id],
      metrics: { start: 2.2, end: 2.6 },
    });
    expect(one("eou_wait").metadata).toMatchObject({
      "contrib.livekit.eou.native_end_unix_ms": 2600,
      "contrib.livekit.eou.wait_duration": 0.6,
    });
    expect(one("eou_wait").metadata["contrib.livekit.events"]).toContainEqual({
      name: "user_resumed",
      time_unix_ms: 2300,
      attributes: {},
    });
  });

  test.each(["dropped", "committed", "unknown"])(
    "native %s only maps known outcomes",
    async (outcome) => {
      const root = start("agent_session");
      now = 2200;
      const { wait } = vadWait(root, 2000);
      wait.setAttribute("lk.eou.outcome", outcome);
      wait.end(2500);
      const { one } = await rows();
      expect(one("eou_wait").span_parents).toEqual([one("session").span_id]);
      expect(one("eou_wait").metadata).not.toHaveProperty("turn.id");
      expect(one("eou_wait").metadata).not.toHaveProperty(
        "audio.participant_ids",
      );
      expect(one("eou_wait").metadata["eou.outcome"]).toBe(
        outcome === "unknown" ? undefined : outcome,
      );
      expect(one("eou_wait").metadata["contrib.livekit.eou.outcome"]).toBe(
        outcome,
      );
      expect(one("eou_wait").metadata).not.toHaveProperty("eou.end_reason");
    },
  );

  test.each(["session", "processor"])(
    "%s shutdown closes unfinished waits and detectors without inventing outcomes",
    async (mode) => {
      const root = start("agent_session");
      const turn = start("user_turn", root);
      now = 2200;
      const { wait } = vadWait(turn, 2000);
      start("eou_detection", wait, {}, 2200);
      now = 2600;
      if (mode === "session") {
        turn.end(2600);
        root.end(2600);
        await tracing.closeSession(root);
      } else await tracing.shutdown();
      expect(tracing.sessions.size).toBe(0);
      // A late native result cannot turn the observed incomplete boundary into commitment.
      wait.setAttribute("lk.eou.outcome", "committed");
      wait.end(2800);
      const { one } = await rows();
      expect(one("eou_wait")).toMatchObject({
        metrics: { start: 2, end: 2.6 },
        metadata: { "contrib.livekit.incomplete": true },
      });
      expect(one("eou_wait").metadata).not.toHaveProperty("eou.outcome");
      expect(one("livekit.eou_detection").metrics.end).toBe(2.6);
    },
  );

  test.each([undefined, NaN, Infinity, -1, 0, 3000])(
    "missing/invalid speech end %s stays a native diagnostic",
    async (at) => {
      now = 2500;
      const root = start("agent_session");
      const wait = start("eou_wait", root, { "lk.eou.source": "stt" }, 2500);
      const recognition = { lastSpeakingTime: at };
      tracing.processSTT(
        recognition,
        { type: 2, speechEndTime: at, alternatives: [{ text: "hello" }] },
        () => {},
      );
      tracing.eouWait(recognition, wait, {
        lastSpeakingTime: at,
        trigger: "stt",
        endpointingDelay: 0,
      });
      wait.setAttribute("lk.eou.outcome", "committed");
      wait.end(2800);
      const { one, named } = await rows();
      expect(named("eou_wait")).toHaveLength(0);
      expect(one("livekit.eou_wait").metadata).toMatchObject({
        "contrib.livekit.eou.outcome": "committed",
        "contrib.livekit.eou.canonical_omitted": "unobserved_speech_end",
      });
      for (const key of [
        "eou.outcome",
        "eou.speech_end_source",
        "eou.end_reason",
        "eou.detection_methods",
      ])
        expect(one("livekit.eou_wait").metadata).not.toHaveProperty(key);
    },
  );

  test("STT receipt time and synthetic VAD notifications never establish a speech-end anchor", async () => {
    const root = start("agent_session");
    now = 2500;
    const recognition = { lastSpeakingTime: 2500, turnDetectionMode: "stt" };
    const wait = start("eou_wait", root, {}, 2500);
    const result = tracing.processSTT(recognition, { type: 3 }, () => {
      tracing.speechEnd(
        { agentSession: {}, audioRecognition: recognition },
        { type: 2, silenceDuration: 0, inferenceDuration: 0 },
      );
      return "original result";
    });
    expect(result).toBe("original result");
    tracing.eouWait(recognition, wait, {
      lastSpeakingTime: 2500,
      trigger: "stt",
      endpointingDelay: 0,
    });
    wait.end(2800);
    expect((await rows()).named("eou_wait")).toHaveLength(0);
  });

  test.each([undefined, 1900, 2900])(
    "invalid/missing resume time %s cannot normalize an extended native wait",
    async (at) => {
      const root = start("agent_session");
      now = 2200;
      const { wait } = vadWait(root, 2000);
      if (at !== undefined) wait.addEvent("user_resumed", {}, at);
      wait.setAttribute("lk.eou.outcome", "user_resumed");
      wait.end(2600);
      const { one, named } = await rows();
      expect(named("eou_wait")).toHaveLength(0);
      expect(
        one("livekit.eou_wait").metadata[
          "contrib.livekit.eou.canonical_omitted"
        ],
      ).toBe("unobserved_wait_end");
    },
  );
});

describe("speech", () => {
  test("speech keeps native timing; transcripts never move it or claim it", async () => {
    const root = start("agent_session");
    const agent = start("agent_speaking", root);
    const user = start("user_turn", root);
    const caller = start("user_speaking", user, {}, [3, 0]);
    caller.end([4, 0]);
    tracing.stt(
      { userTurnSpan: user },
      {
        type: 2,
        alternatives: [{ text: "Wait, order 1042" }],
      },
    );
    const session = { sessionSpan: root, agentSpeakingSpan: agent };
    tracing.conversation(session, {
      type: "message",
      id: "late",
      role: "user",
      textContent: "Wait, order 1042",
      metrics: { startedSpeakingAt: 3 },
    });
    tracing.conversation(session, {
      type: "message",
      id: "answer",
      role: "assistant",
      textContent: "It arrives Friday.",
      metrics: { startedSpeakingAt: 1 },
    });
    agent.end([6, 0]);
    user.end([7, 0]);
    const { one } = await rows();
    // User speech is observed audio only; its text stays on the STT span.
    expect(one("user_speech")).toMatchObject({
      span_parents: [one("user_turn").span_id],
      metrics: { start: 3, end: 4 },
    });
    expect(one("user_speech").input).toBeUndefined();
    expect(one("user_speech").metadata).not.toHaveProperty(
      "contrib.livekit.message_ids",
    );
    expect(one("agent_speech")).toMatchObject({
      metrics: { start: 1, end: 6 },
      output: [{ role: "assistant", content: "It arrives Friday." }],
    });
  });

  test("a multi-interval turn's message resolves to all of its transcripts, whatever the timestamps", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    // VAD splits one turn into speech intervals; LiveKit stamps their starts
    // separately from the turn's, so none need match the message.
    for (const [from, to] of [
      [
        [1, 2_000_000],
        [2, 0],
      ],
      [
        [2, 500_000_000],
        [3, 0],
      ],
      [
        [3, 500_000_000],
        [4, 0],
      ],
    ] as [SpanTime, SpanTime][]) {
      start("user_speaking", user, {}, from).end(to);
      tracing.stt(
        { userTurnSpan: user },
        {
          type: 2,
          alternatives: [{ text: "part" }],
        },
      );
    }
    const session = { sessionSpan: root };
    tracing.userTurn(
      { agentSession: session },
      { userTurnSpan: user, startedSpeakingAt: 1000, stoppedSpeakingAt: 4000 },
    );
    user.end([4, 0]);
    tracing.conversation(session, {
      type: "message",
      id: "caller",
      role: "user",
      textContent: "part part part",
      metrics: { startedSpeakingAt: 1 },
    });
    const model = start("llm_node", start("agent_turn", root), {
      "lk.pii.chat_ctx": JSON.stringify({
        items: [{ type: "message", id: "caller", role: "user", content: [] }],
      }),
    });
    model.end();
    await tracing.closeSession(root);
    root.end();
    const { named, one } = await rows();
    expect(
      one("llm_response").metadata.links.map((l: any) => l.context.spanId),
    ).toEqual(named("transcript_received").map((r) => r.span_id));
    expect(one("session").metadata).not.toHaveProperty(
      "contrib.livekit.unassociated_messages",
    );
  });

  /** A final transcript event, as LiveKit's recognizer reports it. */
  const final = (text: string, createdAt: number) => ({
    type: 2,
    alternatives: [{ text }],
    createdAt,
  });

  test("transcript receipts retain the observed turn even when it closes before finalization", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    const recognition: { userTurnSpan?: NativeSpan } = { userTurnSpan: user };
    tracing.stt(recognition, {
      type: 1,
      alternatives: [{ text: "and we" }],
      createdAt: 1_100,
    });
    tracing.stt(recognition, {
      type: 1,
      alternatives: [{ text: "and we haven't" }],
      createdAt: 1_400,
    });
    // LiveKit closes the turn on silence before the final transcript arrives.
    user.end([1, 500_000_000]);
    recognition.userTurnSpan = undefined;
    tracing.stt(recognition, final("and we haven't heard anything.", 1_900));
    const { one } = await rows();
    expect(one("transcript_received")).toMatchObject({
      span_parents: [one("user_turn").span_id],
      metrics: { start: 1.9, end: 1.9 },
      output: [{ role: "user", content: "and we haven't heard anything." }],
      metadata: { "turn.id": one("user_turn").span_id },
    });
  });

  test("transcript timestamps describe receipt regardless of interim results", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    const recognition = { userTurnSpan: user };
    for (const [text, at] of [
      ["Hi.", 1_000],
      ["Hi, I'm calling", 1_200],
    ] as const)
      tracing.stt(recognition, {
        type: 1,
        alternatives: [{ text }],
        createdAt: at,
      });
    tracing.stt(recognition, final("Hi, I'm calling.", 1_500));
    // Between utterances the provider sends empty interims: no recognition yet.
    tracing.stt(recognition, {
      type: 1,
      alternatives: [{ text: "" }],
      createdAt: 1_600,
    });
    tracing.stt(recognition, {
      type: 1,
      alternatives: [{ text: "Where is" }],
      createdAt: 2_000,
    });
    tracing.stt(recognition, final("Where is my order?", 2_600));
    user.end();
    expect(
      (await rows())
        .named("transcript_received")
        .map((r) => [r.metrics.start, r.metrics.end]),
    ).toEqual([
      [1.5, 1.5],
      [2.6, 2.6],
    ]);
  });

  test("speech events alone do not establish a recognition interval", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    const recognition = { userTurnSpan: user };
    tracing.stt(recognition, { type: 0, createdAt: 1_000 });
    tracing.stt(recognition, { type: 3, createdAt: 2_000 });
    tracing.stt(recognition, final("Where is my order?", 2_700));
    user.end();
    const { one } = await rows();
    expect(one("transcript_received")).toMatchObject({
      span_parents: [one("user_turn").span_id],
      metrics: { start: 2.7, end: 2.7 },
      metadata: { "turn.id": one("user_turn").span_id },
    });
  });

  test("an END_OF_SPEECH trailing its final does not begin the next recognition", async () => {
    const root = start("agent_session");
    const first = start("user_turn", root);
    const recognition = { userTurnSpan: first };
    tracing.stt(recognition, {
      type: 1,
      alternatives: [{ text: "Hi" }],
      createdAt: 1_100,
    });
    tracing.stt(recognition, final("Hi.", 1_200));
    // LiveKit's inference STT reports the end of speech after its final.
    tracing.stt(recognition, { type: 3, createdAt: 1_201 });
    first.end();
    const second = start("user_turn", root);
    recognition.userTurnSpan = second;
    tracing.stt(recognition, { type: 0, createdAt: 2_000 });
    tracing.stt(recognition, {
      type: 1,
      alternatives: [{ text: "Where" }],
      createdAt: 2_100,
    });
    tracing.stt(recognition, final("Where is my order?", 2_200));
    second.end();
    const { named } = await rows();
    const [a, b] = named("user_turn").map((turn) => turn.span_id);
    expect(named("transcript_received")).toMatchObject([
      {
        span_parents: [a],
        metrics: { start: 1.2, end: 1.2 },
        metadata: { "turn.id": a },
      },
      {
        span_parents: [b],
        metrics: { start: 2.2, end: 2.2 },
        metadata: { "turn.id": b },
      },
    ]);
  });

  test("a final with nothing before it is an instant, under the session when no turn is open", async () => {
    const root = start("agent_session");
    tracing.stt(
      {
        userTurnSpan: undefined,
        rootSpanContext: { getValue: () => root },
      },
      final("Hello?", 3_000),
    );
    const { one } = await rows();
    expect(one("transcript_received")).toMatchObject({
      span_parents: [one("session").span_id],
      metrics: { start: 3, end: 3 },
    });
  });

  test("a user turn's input is the transcript LiveKit reports for it", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    // LiveKit stamps the turn's joined final transcripts when the turn ends.
    user.setAttributes({
      "lk.pii.user_transcript": "Hi. Where is order 1042?",
      "lk.transcript_confidence": 0.98,
    });
    user.end();
    const silent = start("user_turn", root);
    silent.setAttributes({ "lk.pii.user_transcript": "" });
    silent.end();
    const [turn, empty] = (await rows()).named("user_turn");
    expect(turn).toMatchObject({
      input: [{ role: "user", content: "Hi. Where is order 1042?" }],
      metadata: { "contrib.livekit.transcript_confidence": 0.98 },
    });
    // The transcript is content, not metadata.
    expect(JSON.stringify(turn.metadata)).not.toContain("order 1042");
    expect(empty.input).toBeUndefined();
  });

  test("an agent turn's input is the user message LiveKit reports prompting it", async () => {
    const root = start("agent_session");
    // Typed input has no user turn: the agent turn is the only turn with it.
    const typed = start("agent_turn", root);
    typed.setAttributes({ "lk.pii.user_input": "QX7-48B2-ZZ1" });
    typed.end();
    // A reply LiveKit starts on its own, such as a greeting, has no user input.
    const greeting = start("agent_turn", root);
    greeting.setAttributes({ "lk.pii.user_input": "" });
    greeting.end();
    const [turn, unprompted] = (await rows()).named("agent_turn");
    expect(turn.input).toEqual([{ role: "user", content: "QX7-48B2-ZZ1" }]);
    expect(JSON.stringify(turn.metadata)).not.toContain("QX7");
    expect(unprompted.input).toBeUndefined();
  });

  test("a reply started within its user turn answers that turn, by identity rather than timing", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    tracing.stt({ userTurnSpan: user }, final("Where is my order?", 1_500));
    const session = { sessionSpan: root };
    // LiveKit starts the reply (preemptively, or at turn completion) within the
    // turn's own call, handing it the turn's message, which has no speaking times.
    const message = {
      type: "message",
      id: "item_9c21",
      role: "user",
      textContent: "Where is my order?",
    };
    const turn = tracing.scope(user, () => {
      const reply = start("agent_turn", root);
      tracing.reply({ span: reply, newMessage: message });
      return reply;
    });
    user.end();
    tracing.conversation(session, message);
    const model = start("llm_node", turn, {
      "lk.pii.chat_ctx": JSON.stringify({
        items: [
          { type: "message", id: "item_9c21", role: "user", content: [] },
        ],
      }),
    });
    model.end();
    turn.end();
    const { one } = await rows();
    expect(one("agent_turn").metadata["turn.reply_to"]).toBe(
      one("user_turn").span_id,
    );
    expect(one("user_turn").metadata["contrib.livekit.message_id"]).toBe(
      "item_9c21",
    );
    expect(
      one("llm_response").metadata.links.map((l: any) => l.context.spanId),
    ).toEqual([one("transcript_received").span_id]);
  });

  test("a committed user message adds its native ID and speaking times to its turn", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    const session = { sessionSpan: root };
    tracing.userTurn(
      { agentSession: session },
      { userTurnSpan: user, startedSpeakingAt: 1500, stoppedSpeakingAt: 4200 },
    );
    user.end();
    tracing.conversation(session, {
      type: "message",
      id: "item_abc",
      role: "user",
      textContent: "Hi. Where is order 1042?",
      metrics: {
        startedSpeakingAt: 1.5,
        stoppedSpeakingAt: 4.2,
        onUserTurnCompletedDelay: 0.002,
      },
    });
    expect((await rows()).one("user_turn").metadata).toMatchObject({
      "contrib.livekit.message_id": "item_abc",
      "contrib.livekit.started_speaking_at": 1.5,
      "contrib.livekit.stopped_speaking_at": 4.2,
      "contrib.livekit.on_user_turn_completed_delay": 0.002,
    });
  });

  test("a user message without LiveKit's turn key decorates no turn", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    const session = { sessionSpan: root };
    tracing.userTurn(
      { agentSession: session },
      { userTurnSpan: user, startedSpeakingAt: 1500, stoppedSpeakingAt: 4200 },
    );
    user.end();
    // A late transcript's turn commits a message without speaking times.
    tracing.conversation(session, {
      type: "message",
      id: "item_late",
      role: "user",
      textContent: "and we haven't heard anything.",
      metrics: { onUserTurnCompletedDelay: 0 },
    });
    expect((await rows()).one("user_turn").metadata).not.toHaveProperty(
      "contrib.livekit.message_id",
    );
  });

  test("a user message without a native turn links to nothing", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    start("user_speaking", user).end([2, 0]);
    tracing.stt(
      { userTurnSpan: user },
      {
        type: 2,
        alternatives: [{ text: "Earlier" }],
      },
    );
    user.end([2, 0]);
    // Typed input has no native turn start; ambiguous turn keys resolve to none.
    const session = { sessionSpan: root };
    const other = start("user_turn", root);
    for (const turn of [user, other])
      tracing.userTurn(
        { agentSession: session },
        { userTurnSpan: turn, startedSpeakingAt: 5000 },
      );
    other.end();
    for (const [id, metrics] of [
      ["typed", undefined],
      ["ambiguous", { startedSpeakingAt: 5 }],
    ] as const)
      tracing.conversation(session, {
        type: "message",
        id,
        role: "user",
        textContent: id,
        metrics,
      });
    const model = start("llm_node", start("agent_turn", root), {
      "lk.pii.chat_ctx": JSON.stringify({
        items: ["typed", "ambiguous"].map((id) => ({
          type: "message",
          id,
          role: "user",
          content: [id],
        })),
      }),
    });
    model.end();
    root.end([3, 0]);
    await tracing.closeSession(root);
    const { one } = await rows();
    expect(one("llm_response").metadata.links).toBeUndefined();
    expect(one("user_speech").input).toBeUndefined();
    // Only assistant text can be lost without its speech; user text stays on STT.
    expect(one("session").metadata).not.toHaveProperty(
      "contrib.livekit.unassociated_messages",
    );
  });

  test("assistant text committed without played speech is kept on the session", async () => {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    // Two speech intervals in one turn, neither current: which played it is unknown.
    start("agent_speaking", turn).end();
    start("agent_speaking", turn).end();
    tracing.scope(turn, () =>
      tracing.conversation(
        { sessionSpan: root },
        { type: "message", id: "a", role: "assistant", textContent: "Friday" },
      ),
    );
    turn.end();
    await tracing.closeSession(root);
    root.end();
    const { named, one } = await rows();
    expect(named("agent_speech").map((r) => r.output)).toEqual([
      undefined,
      undefined,
    ]);
    expect(
      one("session").metadata["contrib.livekit.unassociated_messages"],
    ).toEqual([{ id: "a", role: "assistant", text: "Friday" }]);
  });

  function speakingSession() {
    const root = start("agent_session");
    const speech = start("agent_speaking", root);
    const sink = Object.assign(new EventEmitter(), {
      captureFrame: async () => {},
      flush() {},
      clearBuffer() {},
    });
    const session: any = {
      sessionSpan: root,
      agentSpeakingSpan: speech,
      output: { audio: sink },
    };
    tracing.output(session);
    return { sink, session };
  }

  test.each([
    ["reports what was heard", "Heard prefix"],
    ["can't report what was heard", undefined],
  ])(
    "an interrupted reply's text is kept only when the sink %s",
    async (_name, synchronizedTranscript) => {
      const { sink, session } = speakingSession();
      sink.emit("playbackFinished", {
        interrupted: true,
        synchronizedTranscript,
      });
      // LiveKit builds the reply's text from the heard transcript when the sink
      // reports one, and otherwise from all the text it sent to be spoken.
      tracing.conversation(session, {
        type: "message",
        id: "answer",
        role: "assistant",
        textContent:
          synchronizedTranscript ?? "Heard prefix and unheard suffix",
        interrupted: true,
      });
      expect((await rows()).one("agent_speech").output).toEqual(
        synchronizedTranscript
          ? [{ role: "assistant", content: synchronizedTranscript }]
          : undefined,
      );
    },
  );

  test("replaced outputs stop reporting; an unreported interruption hides the reply's text", async () => {
    const { sink: first, session } = speakingSession();
    const second = new EventEmitter();
    session.output.audio = second;
    tracing.output(session);
    expect(first.listenerCount("playbackFinished")).toBe(0);
    session.output.audio = first;
    tracing.output(session);
    expect(second.listenerCount("playbackFinished")).toBe(0);
    first.emit("playbackFinished", { synchronizedTranscript: "partial" });
    tracing.conversation(session, {
      type: "message",
      id: "first",
      role: "assistant",
      textContent: "Fully played prefix and partial",
      interrupted: true,
    });
    first.emit("playbackFinished", { interrupted: true });
    tracing.conversation(session, {
      type: "message",
      id: "unverified",
      role: "assistant",
      textContent: "unheard",
      interrupted: true,
    });
    const speech = (await rows()).one("agent_speech");
    expect(speech.output).toEqual([
      { role: "assistant", content: "Fully played prefix and partial" },
    ]);
    expect(JSON.stringify(speech)).not.toContain("unheard");
  });
});

describe("recording", () => {
  beforeEach(() => {
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
  });
  /** A recorded session with one agent turn and an EventEmitter sink. */
  function session(
    captureFrame: (
      sink: EventEmitter,
    ) => (frame: unknown) => Promise<unknown> = () => async () => {},
  ) {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const speaking = start("agent_speaking", turn);
    const sink: any = new EventEmitter();
    Object.assign(sink, {
      captureFrame: captureFrame(sink),
      flush() {},
      clearBuffer() {},
    });
    const agentSession: any = {
      sessionSpan: root,
      activity: { currentSpeech: { _agentTurnSpan: turn } },
      agentSpeakingSpan: speaking,
      output: { audio: sink },
    };
    tracing.output(agentSession);
    const origin = now;
    return {
      root,
      turn,
      sink,
      session: agentSession,
      origin,
      async close() {
        speaking.end();
        turn.end();
        await tracing.closeSession(root);
        root.end();
        const result = await rows();
        const metadata = result.named("session")[0].metadata;
        const audio = audioOf(metadata);
        /** A span's selections on the session timeline: [start, end] in ms. */
        const selections = (name: string) => selectionsOf(result.one(name));
        return {
          ...result,
          audio,
          segments: segmentsOf(audio),
          stopReason: metadata?.["contrib.livekit.audio.stop_reason"],
          selections,
        };
      },
    };
  }

  test("the shared attachment flag alone records no voice audio", async () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
    const stream = new ReadableStream();
    const { getReader } = stream;
    const { sink, session: agentSession, close } = session();
    const { captureFrame } = sink;
    tracing.input({ agentSession }, stream);
    tracing.output(agentSession);
    expect(stream.getReader).toBe(getReader);
    expect(sink.captureFrame).toBe(captureFrame);
    expect((await close()).segments).toEqual([]);
  });

  test("user audio alone taps the input and leaves the sink untouched", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
    const stream = new ReadableStream();
    const { getReader } = stream;
    const { sink, session: agentSession, close } = session();
    const { captureFrame } = sink;
    tracing.input({ agentSession }, stream);
    tracing.output(agentSession);
    expect(stream.getReader).not.toBe(getReader);
    expect(sink.captureFrame).toBe(captureFrame);
    await close();
  });

  test("agent audio alone records playback and leaves the input untouched", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "");
    const stream = new ReadableStream();
    const { getReader } = stream;
    const { sink, origin, session: agentSession, close } = session();
    tracing.input({ agentSession }, stream);
    expect(stream.getReader).toBe(getReader);
    await sink.captureFrame(frame());
    sink.emit("playbackStarted", { createdAt: origin + 10 });
    sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
    const { audio, segments } = await close();
    // The silent caller channel names no source.
    expect(audio.sources).toEqual(SESSION_SOURCES);
    expect(segments).toMatchObject([
      {
        state: "ready",
        channels: {
          "0": { sources: [] },
          "1": { sources: ["agent-output"] },
        },
      },
    ]);
  });

  test("close resolves after the recording is uploaded and published", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(Attachment.prototype.upload).mockImplementation(async () => {
      await gate;
      return { upload_status: "done" };
    });
    const { root, sink, origin, session: agentSession } = session();
    await sink.captureFrame(frame());
    sink.emit("playbackStarted", { createdAt: origin + 10 });
    sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
    let closed = false;
    const closing = tracing
      .close(agentSession, async () => {})
      .then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    release();
    await closing;
    root.end();
    const audio = audioOf((await rows()).named("session")[0].metadata);
    expect(segmentsOf(audio)).toMatchObject([{ id: "part-0", state: "ready" }]);
  });

  test("close keeps LiveKit's error and still finishes the recording", async () => {
    const error = new Error("close failed");
    const { root, sink, session: agentSession } = session();
    await sink.captureFrame(frame());
    await expect(
      tracing.close(agentSession, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    root.end();
    const metadata = (await rows()).named("session")[0].metadata;
    // Unconfirmed playback makes no segment, but the recording still finishes.
    expect(segmentsOf(audioOf(metadata))).toEqual([]);
    expect(metadata?.["contrib.livekit.audio.output_formats"]).toEqual([]);
  });

  /** Replaces the default tracing with one that runs the given middleware. */
  async function withMiddleware(
    middleware: AudioMiddleware,
    chunkBytes = DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES,
  ) {
    await tracing.shutdown();
    tracing = new LiveKitTracing(chunkBytes, () => [middleware]);
  }
  /** One agent frame played for 20 ms starting 10 ms into the call. */
  async function playOneFrame(sink: EventEmitter & any, origin: number) {
    await sink.captureFrame(frame());
    sink.emit("playbackStarted", { createdAt: origin + 10 });
    sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
  }

  test("disabled audio capture never runs middleware", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
    const middleware = vi.fn<AudioMiddleware>();
    await withMiddleware(middleware);
    const { sink, origin, close } = session();
    await playOneFrame(sink, origin);
    // The session is still described; no audio is recorded.
    expect((await close()).audio).toEqual({
      "schema.version": "3.1.0",
      sources: SESSION_SOURCES,
      timeline: { origin_unix_ms: origin },
    });
    expect(middleware).not.toHaveBeenCalled();
  });

  test("middleware output is uploaded with its format; selections are unchanged", async () => {
    await withMiddleware(async (segment, meta, next) => {
      const framed = new Uint8Array(segment.length + 4);
      framed.set([0x54, 0x45, 0x53, 0x54]);
      framed.set(segment, 4);
      return next(framed, {
        ...meta,
        mimeType: "audio/x-test",
        encoding: "test",
        attributes: { "acme.framing": "test" },
        state: { "acme.header": framed.subarray(0, 4) },
      });
    });
    const { sink, origin, close } = session();
    await playOneFrame(sink, origin);
    const { audio, segments, selections, named } = await close();
    expect(segments).toEqual([
      {
        id: "part-0",
        state: "ready",
        start_offset_ms: 0,
        duration_ms: 30, // Includes the 10 ms before playout started.
        attachment: { ref: "/input/audio/part-0" },
        mime_type: "audio/x-test",
        encoding: "test",
        sample_rate_hz: 24000,
        channels: {
          "0": { sources: [] },
          "1": { sources: ["agent-output"] },
        },
        // Attributes describe the file; pipeline state is never published.
        attributes: { "acme.framing": "test" },
      },
    ]);
    expect(JSON.stringify(audio)).not.toContain("acme.header");
    expect(selections("agent_speech")).toEqual([[10, 30]]);
    expect(selections("agent_turn")).toEqual([]);
    expect([...uploads[0].slice(0, 4)]).toEqual([0x54, 0x45, 0x53, 0x54]);
    expect(channelSamples(uploads[0].slice(4), 1)[300]).toBe(1234);
    const attachment = named("session").find((row) => row.input?.audio)?.input
      .audio["part-0"];
    expect(attachment).toMatchObject({
      filename: "part-0.x-test",
      content_type: "audio/x-test",
    });
  });

  test("failing middleware omits its file without changing sink I/O", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await withMiddleware(() => {
      throw new Error("encoder unavailable");
    });
    const { sink, origin, close } = session();
    await expect(playOneFrame(sink, origin)).resolves.toBeUndefined();
    const { segments, stopReason, selections } = await close();
    // An omitted segment keeps its place on the timeline.
    expect(segments).toEqual([
      {
        id: "part-0",
        state: "omitted",
        start_offset_ms: 0,
        duration_ms: 30,
        reason: "recording_transform_failed",
      },
    ]);
    expect(stopReason).toBe("recording_transform_failed");
    // Confirmed playback is still on the timeline, though its audio is unavailable.
    expect(selections("agent_speech")).toEqual([[10, 30]]);
    expect(uploads).toEqual([]);
  });

  test("slow middleware never delays playback; close waits for it", async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 100 ms segments of 24 kHz stereo s16le.
    await withMiddleware(async (segment, meta, next) => {
      entered++;
      await gate;
      return next(segment, meta);
    }, 9600);
    const { sink, origin, close } = session();
    const play = async (startedAt: number) => {
      await sink.captureFrame(frame(2400));
      sink.emit("playbackStarted", { createdAt: startedAt });
      sink.emit("playbackFinished", {
        playbackPosition: 0.1,
        interrupted: false,
      });
    };
    await play(origin);
    now = origin + 2000; // The first 100 ms are now safe to cut.
    await play(origin + 1500);
    expect(entered).toBe(1);
    // Later playback completes while that segment is held in middleware.
    await play(origin + 1700);
    expect(uploads).toEqual([]);
    const closing = close();
    release();
    const { segments } = await closing;
    // The empty interval between playouts is skipped, not uploaded as silence.
    expect(
      segments.map((r: any) => [r.state, r.start_offset_ms, r.duration_ms]),
    ).toEqual([
      ["ready", 0, 100],
      ["ready", 1500, 100],
      ["ready", 1700, 100],
    ]);
  });

  test("interruption records only confirmed progress ranges, excluding the queued tail and pauses", async () => {
    const { sink, origin, close } = session();
    await sink.captureFrame(frame(2400)); // 100 ms generated
    sink.emit("playbackProgressed", {
      startedAt: origin + 10,
      offset: 0,
      duration: 20,
    });
    sink.emit("playbackProgressed", {
      startedAt: origin + 60,
      offset: 40,
      duration: 20,
    });
    sink.emit("playbackFinished", {
      playbackPosition: 0.04,
      interrupted: true,
      synchronizedTranscript: "heard",
    });
    const { audio, segments, selections, one } = await close();
    expect(audio.timeline.origin_unix_ms).toBe(origin);
    expect(segments).toMatchObject([
      { id: "part-0", state: "ready", start_offset_ms: 0, duration_ms: 80 },
    ]);
    expect(selections("agent_speech")).toEqual([
      [10, 30],
      [60, 80],
    ]);
    expect(
      one("agent_turn").metadata["contrib.livekit.playback_events"],
    ).toMatchObject([
      {
        name: "playbackFinished",
        attributes: { interrupted: true, synchronizedTranscript: "heard" },
      },
    ]);
    const played = channelSamples(uploads[0], 1);
    expect(played).toHaveLength(1920);
    expect([played[240], played[960]]).toEqual([1234, 0]);
  });

  test("synchronous completion during an in-flight capture is settled after acceptance", async () => {
    let origin = 0;
    const { sink, close, ...rest } = session((sink) => async () => {
      sink.emit("playbackStarted", { createdAt: origin + 10 });
      sink.emit("playbackFinished", {
        playbackPosition: 0.02,
        interrupted: false,
      });
    });
    origin = rest.origin;
    await sink.captureFrame(frame());
    expect((await close()).selections("agent_speech")).toEqual([[10, 30]]);
  });

  test.each([
    ["failed capture", "output_capture_failed"],
    ["unknown interrupted playout", "output_playout_mapping_unavailable"],
  ])("%s omits the recording instead of guessing", async (name, reason) => {
    const error = new Error("sink failure");
    const failing = name === "failed capture";
    const { sink, close } = session(() => async () => {
      if (failing) throw error;
    });
    if (failing) await expect(sink.captureFrame(frame())).rejects.toBe(error);
    else {
      await sink.captureFrame(frame());
      sink.emit("playbackFinished", {
        playbackPosition: 0.01,
        interrupted: true,
      });
    }
    const { segments, stopReason } = await close();
    expect(segments).toEqual([]);
    expect(stopReason).toBe(reason);
    expect(uploads).toEqual([]);
  });

  test("the internal ceiling stops capture without changing sink I/O", async () => {
    let accepted = 0;
    const { sink, close } = session(() => async () => {
      accepted++;
    });
    await sink.captureFrame(frame(16 * 1024 * 1024));
    await sink.captureFrame(frame());
    sink.emit("playbackFinished", {
      playbackPosition: 0.04,
      interrupted: false,
    });
    expect(accepted).toBe(2);
    expect((await close()).stopReason).toBe("capture_byte_limit");
  });

  test("a sink shared by open sessions stops both recordings without changing playback", async () => {
    const delivered: unknown[] = [];
    const a = session(() => async (value) => {
      delivered.push(value);
      return "played";
    });
    const root = start("agent_session");
    tracing.output({ sessionSpan: root, output: { audio: a.sink } } as any);
    const audio = frame();
    expect(await a.sink.captureFrame(audio)).toBe("played");
    expect(delivered).toEqual([audio]);
    root.end();
    await tracing.closeSession(root);
    expect((await a.close()).named("session")).toMatchObject([
      {
        metadata: {
          "contrib.livekit.audio.stop_reason": "shared_output_unsupported",
        },
      },
      {
        metadata: {
          "contrib.livekit.audio.stop_reason": "shared_output_unsupported",
        },
      },
    ]);
  });

  /** Plays one frame the way LiveKit sequences it: the sink reports playback, then speech starts. */
  async function playThenSpeak(
    ctx: ReturnType<typeof session>,
    at: number,
    progress: boolean,
  ) {
    ctx.session.agentSpeakingSpan = undefined;
    await ctx.sink.captureFrame(frame());
    ctx.sink.emit("playbackStarted", { createdAt: ctx.origin + at });
    const speaking = start("agent_speaking", ctx.turn);
    ctx.session.agentSpeakingSpan = speaking;
    if (progress)
      ctx.sink.emit("playbackProgressed", {
        startedAt: ctx.origin + at,
        offset: 0,
        duration: 20,
      });
    return speaking;
  }

  test.each([
    ["with", true],
    ["without", false],
  ])(
    "playback that finishes after its speech ends keeps its selection (%s progress events)",
    async (_name, progress) => {
      const ctx = session();
      const speaking = await playThenSpeak(ctx, 10, progress);
      // The speech span ends before the sink reports the end of playback.
      speaking.end();
      ctx.session.agentSpeakingSpan = undefined;
      ctx.sink.emit("playbackFinished", {
        playbackPosition: 0.02,
        interrupted: false,
      });
      const { named } = await ctx.close();
      expect(named("agent_speech").map(selectionsOf)).toContainEqual([
        [10, 30],
      ]);
    },
  );

  test.each([
    ["with", true],
    ["without", false],
  ])(
    "agent speech is selected without recording audio (%s progress events)",
    async (_name, progress) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "");
      vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
      const ctx = session();
      const { captureFrame } = ctx.sink;
      const speaking = await playThenSpeak(ctx, 10, progress);
      ctx.sink.emit("playbackFinished", {
        playbackPosition: 0.02,
        interrupted: false,
      });
      speaking.end();
      const { named, segments } = await ctx.close();
      // Nothing was recorded, and the sink was left untouched.
      expect(segments).toEqual([]);
      expect(ctx.sink.captureFrame).toBe(captureFrame);
      expect(named("agent_speech").map(selectionsOf)).toContainEqual([
        [10, 30],
      ]);
    },
  );

  test("an interrupted reply keeps its heard text when playback finishes after its speech ends", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
    const base = session();
    // A reply turn of its own, apart from the session fixture's speech.
    const ctx = { ...base, turn: start("agent_turn", base.root) };
    base.session.activity.currentSpeech._agentTurnSpan = ctx.turn;
    const speaking = await playThenSpeak(ctx, 10, true);
    speaking.end();
    ctx.session.agentSpeakingSpan = undefined;
    ctx.sink.emit("playbackFinished", {
      playbackPosition: 0.01,
      interrupted: true,
      synchronizedTranscript: "It arrives",
    });
    tracing.scope(ctx.turn, () =>
      tracing.conversation(ctx.session, {
        type: "message",
        id: "answer",
        role: "assistant",
        textContent: "It arrives",
        interrupted: true,
      }),
    );
    ctx.turn.end();
    const { named } = await ctx.close();
    expect(named("agent_speech").map((r) => r.output)).toContainEqual([
      { role: "assistant", content: "It arrives" },
    ]);
  });

  test("a sink that can pause gives no selection without progress events", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
    const ctx = session();
    // LiveKit may pause such a sink mid-playout, so start + position isn't
    // necessarily where the audio was.
    Object.assign(ctx.sink, { canPause: true });
    const speaking = await playThenSpeak(ctx, 10, false);
    ctx.sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
    speaking.end();
    const { named } = await ctx.close();
    expect(named("agent_speech").map(selectionsOf)).not.toContainEqual([
      [10, 30],
    ]);
  });

  test("a repeated playback start during one playout is not a new playout", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
    const ctx = session();
    const speaking = await playThenSpeak(ctx, 10, false);
    ctx.sink.emit("playbackStarted", { createdAt: ctx.origin + 15 });
    ctx.sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
    speaking.end();
    const { named } = await ctx.close();
    expect(named("agent_speech").map(selectionsOf)).toContainEqual([[10, 30]]);
  });

  test("selections are observed playout, not clipped to recorded audio", async () => {
    const ctx = session();
    // An unsupported frame stops the recording before the speech plays.
    await ctx.sink.captureFrame({
      data: new Int16Array(3),
      sampleRate: 24000,
      channels: 2,
    });
    const speaking = await playThenSpeak(ctx, 10, true);
    ctx.sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: false,
    });
    speaking.end();
    const { named, segments, stopReason } = await ctx.close();
    expect(segments).toEqual([]);
    expect(stopReason).toBe("unsupported_frame_format");
    expect(named("agent_speech").map(selectionsOf)).toContainEqual([[10, 30]]);
  });

  test("multiple playback runs in one turn keep selections on each speaking span", async () => {
    const { sink, turn, session: agentSession, origin, close } = session();
    for (const [name, at] of [
      ["ack", 10],
      ["answer", 100],
    ] as const) {
      const speaking = start("agent_speaking", turn, { "lk.name": name });
      agentSession.agentSpeakingSpan = speaking;
      await sink.captureFrame(frame());
      sink.emit("playbackProgressed", {
        startedAt: origin + at,
        offset: 0,
        duration: 20,
      });
      sink.emit("playbackFinished", {
        playbackPosition: 0.02,
        interrupted: false,
      });
      sink.flush();
      speaking.end();
    }
    const { named, selections } = await close();
    expect(
      named("agent_speech")
        .map((r) => selectionsOf(r).map(([start]) => start))
        .filter((list) => list.length),
    ).toEqual([[10], [100]]);
    expect(selections("agent_turn")).toEqual([]);
  });

  test("confirmed playback rotates files during an open utterance; interruption discards the queued tail", async () => {
    tracing = new LiveKitTracing(1920); // 20 ms of 24 kHz stereo
    const { sink, origin, close } = session();
    now += 5000;
    await sink.captureFrame(frame());
    sink.emit("playbackProgressed", {
      startedAt: origin,
      offset: 0,
      duration: 20,
    });
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await sink.captureFrame(frame());
    sink.emit("playbackFinished", {
      playbackPosition: 0.02,
      interrupted: true,
    });
    const { segments, selections } = await close();
    expect(segments).toMatchObject([{ id: "part-0", duration_ms: 20 }]);
    expect(selections("agent_speech")).toEqual([[0, 20]]);
  });

  test("input taps reads in sample time, preserving values, silence, cancellation and locks", async () => {
    const { session: agentSession, origin, close } = session();
    const frames = [frame(480, 1234), frame(480, 0), frame(480, 2345)];
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        for (const value of frames) controller.enqueue(value);
      },
      cancel() {
        cancelled = true;
      },
    });
    tracing.input({ agentSession }, stream);
    const reader = stream.getReader();
    // Late delivery does not shift the ordered sample clock.
    for (const [index, delay] of [20, 41, 62].entries()) {
      now = origin + delay;
      expect((await reader.read()).value).toBe(frames[index]);
    }
    frames[0].data.fill(0);
    await reader.cancel();
    reader.releaseLock();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
    await close();
    expect(channelSamples(uploads[0], 0)).toEqual([
      ...Array(480).fill(1234),
      ...Array(480).fill(0),
      ...Array(480).fill(2345),
    ]);
  });

  /** Two speech intervals in one user turn, as LiveKit's local VAD reports them. */
  async function userTurn(activity: Record<string, unknown>) {
    const ctx = session();
    const { root, session: agentSession, origin } = ctx;
    const user = start("user_turn", root);
    // LiveKit stamps user speech with the room participant whose track it heard.
    const speech = start(
      "user_speaking",
      user,
      { "lk.participant_id": "PA_1", "lk.participant_kind": "SIP" },
      origin + 5,
    );
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(frame(2400));
      },
    });
    tracing.input({ agentSession, ...activity }, stream);
    now = origin + 100;
    await stream.getReader().read();
    speech.end(origin + 500);
    start("user_speaking", user, {}, origin + 600).end(origin + 700);
    tracing.userTurn(
      { agentSession, ...activity },
      {
        userTurnSpan: user,
        startedSpeakingAt: origin + 5,
        stoppedSpeakingAt: origin + 700,
      },
    );
    user.end();
    return ctx.close();
  }

  test("user speech names its source and LiveKit's room participant", async () => {
    const { audio, named } = await userTurn({ vad: {} });
    expect(named("user_speech").map((r) => r.metadata)).toEqual([
      expect.objectContaining({
        "audio.source_id": "session-input",
        "audio.participant_ids": ["participant-1"],
      }),
      expect.not.objectContaining({
        "audio.participant_ids": expect.anything(),
      }),
    ]);
    expect(audio.participants).toEqual({
      "participant-1": {
        type: "user",
        attributes: {
          "contrib.livekit.participant_id": "PA_1",
          "contrib.livekit.participant_kind": "SIP",
        },
      },
    });
    expect(audio.segments["part-0"].channels["0"]).toEqual({
      sources: ["session-input"],
    });
  });

  test("with a local VAD, user speech and its turn are selected from LiveKit's speech timing", async () => {
    const { named, one } = await userTurn({ vad: {} });
    expect(named("user_speech").map(selectionsOf)).toEqual([
      [[5, 500]],
      [[600, 700]],
    ]);
    // First to last speech, including the pause between.
    expect(selectionsOf(one("user_turn"))).toEqual([[5, 700]]);
  });

  test("user selections need no recorded audio", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "");
    const { named, one, segments } = await userTurn({ vad: {} });
    expect(segments).toEqual([]);
    expect(named("user_speech").map(selectionsOf)).toEqual([
      [[5, 500]],
      [[600, 700]],
    ]);
    expect(selectionsOf(one("user_turn"))).toEqual([[5, 700]]);
  });

  test.each([
    ["no VAD", {}],
    ["STT turn detection", { vad: {}, turnDetectionMode: "stt" }],
  ])(
    "with %s, user speech timing comes from the STT provider and is not selected",
    async (_name, activity) => {
      const { named, one } = await userTurn(activity);
      expect(named("user_speech").map(selectionsOf)).toEqual([[], []]);
      expect(selectionsOf(one("user_turn"))).toEqual([]);
    },
  );

  test("diarized transcripts name their speakers; participants stay the connections", async () => {
    const { root, close } = session();
    // LiveKit stamps the turn and its speech with the linked room participant.
    const turn = start("user_turn", root);
    turn.setAttributes({
      "lk.participant_id": "PA_room",
      "lk.participant_kind": "STANDARD",
    });
    const recognition = { userTurnSpan: turn };
    for (const speakerId of ["0", "1", "0", null])
      tracing.stt(recognition, {
        type: 2,
        alternatives: [{ text: `speaker ${speakerId}`, speakerId }],
      });
    start("user_speaking", turn, {
      "lk.participant_id": "PA_room",
      "lk.participant_kind": "STANDARD",
    }).end();
    turn.end();
    const { audio, named, one } = await close();
    expect(
      named("transcript_received").map((r) => [
        r.metadata["audio.participant_ids"],
        r.metadata["audio.speaker_ids"],
        r.metadata["contrib.livekit.speaker_id"],
      ]),
    ).toEqual([
      [["participant-1"], ["speaker-1"], "0"],
      [["participant-1"], ["speaker-2"], "1"],
      [["participant-1"], ["speaker-1"], "0"],
      [["participant-1"], undefined, undefined],
    ]);
    // One microphone, two voices: the speech is the connection's, not a speaker's.
    expect(one("user_speech").metadata).toMatchObject({
      "audio.participant_ids": ["participant-1"],
    });
    expect(one("user_speech").metadata).not.toHaveProperty("audio.speaker_ids");
    expect(audio.participants).toEqual({
      "participant-1": {
        type: "user",
        attributes: {
          "contrib.livekit.participant_id": "PA_room",
          "contrib.livekit.participant_kind": "STANDARD",
        },
      },
    });
    // The native label is an index, not a name: it is an attribute, not a label.
    expect(audio.speakers).toEqual({
      "speaker-1": {
        type: "user",
        attributes: { "contrib.livekit.speaker_id": "0" },
      },
      "speaker-2": {
        type: "user",
        attributes: { "contrib.livekit.speaker_id": "1" },
      },
    });
  });

  test("the same label from independent recognizers is not the same speaker", async () => {
    const { root, close } = session();
    for (const participant of ["PA_alice", "PA_bob"]) {
      const turn = start("user_turn", root, {
        "lk.participant_id": participant,
        "lk.participant_kind": "STANDARD",
      });
      const recognition = { userTurnSpan: turn };
      for (const text of ["Hello.", "Where is my order?"])
        tracing.stt(recognition, {
          type: 2,
          alternatives: [{ text, speakerId: "0" }],
        });
      turn.end();
    }
    const { audio, named } = await close();
    expect(
      named("transcript_received").map((r) => [
        r.metadata["audio.speaker_ids"],
        r.metadata["contrib.livekit.speaker_id"],
      ]),
    ).toEqual([
      [["speaker-1"], "0"],
      [["speaker-1"], "0"],
      [["speaker-2"], "0"],
      [["speaker-2"], "0"],
    ]);
    expect(Object.keys(audio.speakers)).toEqual(["speaker-1", "speaker-2"]);
  });

  test("agent speech names the agent's room connection, the same across handoffs", async () => {
    const {
      root,
      turn,
      sink,
      origin,
      session: agentSession,
      close,
    } = session();
    for (const [label, at] of [
      ["support", 10],
      ["billing", 100],
    ] as const) {
      // A handoff starts a new agent activity on the same room connection.
      start("start_agent_activity", root, { "lk.agent_label": label }).end();
      const speaking = start("agent_speaking", turn);
      speaking.setAttributes({
        "lk.participant_id": "PA_agent",
        "lk.participant_kind": "AGENT",
      });
      agentSession.agentSpeakingSpan = speaking;
      await sink.captureFrame(frame());
      sink.emit("playbackProgressed", {
        startedAt: origin + at,
        offset: 0,
        duration: 20,
      });
      sink.emit("playbackFinished", {
        playbackPosition: 0.02,
        interrupted: false,
      });
      speaking.end();
    }
    const { audio, named } = await close();
    // The session fixture's own speech has no connection stamped on it.
    expect(
      named("agent_speech")
        .filter((r) => r.metadata?.["audio.participant_ids"])
        .map((r) => [
          r.metadata["audio.source_id"],
          r.metadata["audio.participant_ids"],
        ]),
    ).toEqual([
      ["agent-output", ["participant-1"]],
      ["agent-output", ["participant-1"]],
    ]);
    // The agent's name identifies the activity, not a member of the call.
    expect(audio.participants).toEqual({
      "participant-1": {
        type: "agent",
        attributes: {
          "contrib.livekit.participant_id": "PA_agent",
          "contrib.livekit.participant_kind": "AGENT",
        },
      },
    });
  });

  test("without a room there are no participants", async () => {
    const { root, turn, close } = session();
    start("start_agent_activity", root, { "lk.agent_label": "support" }).end();
    start("user_speaking", start("user_turn", root)).end();
    start("agent_speaking", turn).end();
    const { audio, named } = await close();
    expect(audio).not.toHaveProperty("participants");
    for (const name of ["user_speech", "agent_speech"])
      expect(named(name)[0].metadata).not.toHaveProperty(
        "audio.participant_ids",
      );
  });

  test.each([
    ["STANDARD", "user"],
    ["CONNECTOR", "user"],
    ["INGRESS", "other"],
    ["EGRESS", "other"],
    ["FUTURE_KIND", "unknown"],
  ])(
    "a %s participant has type %s and keeps its native kind",
    async (kind, type) => {
      const { root, close } = session();
      start("user_speaking", start("user_turn", root), {
        "lk.participant_id": "PA_1",
        "lk.participant_kind": kind,
      }).end();
      expect((await close()).audio.participants["participant-1"]).toEqual({
        type,
        attributes: {
          "contrib.livekit.participant_id": "PA_1",
          "contrib.livekit.participant_kind": kind,
        },
      });
    },
  );

  test("input source replacement and shared input are explicit", async () => {
    const a = session();
    const b = start("agent_session");
    const shared = new ReadableStream();
    tracing.input({ agentSession: a.session }, shared);
    tracing.input({ agentSession: { sessionSpan: b } as any }, shared);
    b.end();
    const c = start("agent_session");
    tracing.input(
      { agentSession: { sessionSpan: c } as any },
      new ReadableStream(),
    );
    tracing.input(
      { agentSession: { sessionSpan: c } as any },
      new ReadableStream(),
    );
    c.end();
    await Promise.all([b, c].map((span) => tracing.closeSession(span)));
    const reasons = (await a.close())
      .named("session")
      .map((r) => r.metadata["contrib.livekit.audio.stop_reason"]);
    expect(reasons).toEqual([
      "shared_input_unsupported",
      "shared_input_unsupported",
      "input_source_change_unsupported",
    ]);
  });
});

describe("recording files", () => {
  const packet = (
    at: number,
    length = 24000,
    source: "session-input" | "agent-output" = "session-input",
  ) => ({
    pcm: Int16Array.from({ length }, (_, i) => ((i * 31) % 30000) - 15000),
    at,
    rate: 24000,
    channels: 1,
    source,
  });
  /**
   * The plugin's session audio, uploading to a session span, with LiveKit
   * capture on top. Its wall-clock hold no longer limits uploads.
   */
  function recording(chunkBytes = DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES) {
    const log = vi.fn();
    const origin = Date.now();
    const plugin = new LiveKitTracing(chunkBytes);
    const audio = Reflect.get(plugin, "audioSession").call(
      plugin,
      { spanId: "root", log },
      origin,
      true,
    );
    const r = new Recording(audio, origin);
    now += 3_600_000;
    /** What the session span has published, merged as Braintrust merges rows. */
    const published = () => {
      const segments: Record<string, any> = {};
      for (const [event] of log.mock.calls)
        Object.assign(segments, event.metadata?.["audio.segments"]);
      return segments;
    };
    return {
      r,
      audio,
      origin,
      /** Records the remaining audio and waits for every file. */
      finish: () => audio.finish(),
      files: () =>
        segmentsOf({ segments: published() }).map((f: any) => [
          f.id,
          f.state,
          f.start_offset_ms,
          f.duration_ms,
        ]),
      segment: (id: string) => published()[id],
      /** Attachment keys logged on the session span, in order. */
      attachments: () =>
        log.mock.calls.flatMap(([event]) =>
          Object.keys(event.input?.audio ?? {}),
        ),
    };
  }

  test("a segment is ready with its attachment only after upload succeeds", async () => {
    let complete!: () => void;
    const blocked = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.mocked(Attachment.prototype.upload).mockImplementation(async () => {
      await blocked;
      return { upload_status: "done" };
    });
    const { r, finish, files, segment, attachments } = recording(96000);
    r.record(packet(0));
    r.advance();
    // The upload starts during the call; nothing references it until it succeeds.
    await vi.waitFor(() =>
      expect(Attachment.prototype.upload).toHaveBeenCalledTimes(1),
    );
    expect(attachments()).toEqual([]);
    complete();
    await finish();
    expect(files()).toEqual([["part-0", "ready", 0, 1000]]);
    expect(segment("part-0")).toMatchObject({
      attachment: { ref: "/input/audio/part-0" },
      mime_type: "audio/pcm",
      encoding: "pcm",
      sample_rate_hz: 24000,
      channels: {
        "0": { sources: ["session-input"] },
        "1": { sources: [] },
      },
      attributes: {
        "pcm.sample_format": "s16le",
        "pcm.channel_layout": "interleaved",
      },
    });
    expect(attachments()).toEqual(["part-0"]);
  });

  test("progressive digests reconstruct both sources exactly across file boundaries", async () => {
    const { r, finish, files } = recording(96000);
    const length = 3 * 24000 + 1777;
    const expected = Buffer.alloc(length * 4);
    for (let at = 0; at < length; at += 719) {
      for (let channel = 0; channel < 2; channel++) {
        const pcm = Int16Array.from(
          { length: Math.min(719, length - at) },
          (_, i) => (((i + at) * (channel ? 31 : 17)) % 30001) - 15000,
        );
        expect(
          r.record({
            pcm,
            at: at / 24,
            rate: 24000,
            channels: 1,
            source: channel ? "agent-output" : "session-input",
          }),
        ).toBe(true);
        for (let i = 0; i < pcm.length; i++)
          expected.writeInt16LE(pcm[i], ((at + i) * 2 + channel) * 2);
      }
      r.advance();
    }
    // Segments upload during the call, before the session closes.
    await vi.waitFor(() => expect(uploads).toHaveLength(3));
    await finish();
    expect(uploads.map((f) => f.length / 4)).toEqual([
      24000, 24000, 24000, 1777,
    ]);
    expect(Buffer.concat(uploads)).toEqual(expected);
    // One complete result, including the final partial segment.
    expect(files()).toEqual([
      ["part-0", "ready", 0, 1000],
      ["part-1", "ready", 1000, 1000],
      ["part-2", "ready", 2000, 1000],
      ["part-3", "ready", 3000, 74],
    ]);
  });

  test("slow uploads bound capture and keep the accepted prefix", async () => {
    let complete!: () => void;
    const blocked = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.mocked(Attachment.prototype.upload).mockImplementation(async () => {
      await blocked;
      return { upload_status: "done" };
    });
    const { r, finish, files } = recording(8 * 1024 * 1024);
    const samples = 2 * 1024 * 1024;
    r.record(packet(0, samples));
    r.advance();
    for (let i = 1; i <= 9; i++) r.record(packet((i * samples) / 24, samples));
    expect(r.reason).toBe("capture_byte_limit");
    complete();
    await finish();
    expect(files().map(([, state]) => state)).toEqual(Array(9).fill("ready"));
    expect(r.metadata()["contrib.livekit.audio.stop_reason"]).toBe(
      "capture_byte_limit",
    );
  });

  test("a failed upload omits its segment without invalidating earlier segments", async () => {
    vi.mocked(Attachment.prototype.upload)
      .mockResolvedValueOnce({ upload_status: "done" })
      .mockResolvedValueOnce({
        upload_status: "error",
        error_message: "offline",
      });
    const { r, finish, files, segment, attachments } = recording(96000);
    for (let i = 0; i < 2; i++) {
      r.record(packet(i * 1000));
      r.advance();
      await vi.waitFor(() =>
        expect(Attachment.prototype.upload).toHaveBeenCalledTimes(i + 1),
      );
    }
    await finish();
    expect(files()).toEqual([
      ["part-0", "ready", 0, 1000],
      ["part-1", "omitted", 1000, 1000],
    ]);
    expect(segment("part-1")).toMatchObject({
      reason: "recording_export_failed",
    });
    expect(segment("part-1")).not.toHaveProperty("attachment");
    expect(attachments()).toEqual(["part-0"]);
    expect(r.metadata()["contrib.livekit.audio.stop_reason"]).toBe(
      "recording_export_failed",
    );
  });

  test("the duration limit keeps accepted audio and finish is idempotent", async () => {
    const { r, audio, finish, files } = recording();
    expect(r.record(packet(0))).toBe(true);
    expect(r.record(packet(30 * 60 * 1000 - 500))).toBe(false);
    expect(audio.finish()).toBe(audio.finish());
    await finish();
    expect(r.reason).toBe("duration_limit");
    expect(files()).toEqual([["part-0", "ready", 0, 1000]]);
    expect(r.metadata()["contrib.livekit.audio.stop_reason"]).toBe(
      "duration_limit",
    );
    expect(r.record(packet(1000))).toBe(false);
  });

  test("empty calls publish sources and timeline without segments or attachments", async () => {
    const { r, audio, origin, finish, files } = recording();
    expect(audio.session()).toEqual({
      "audio.schema.version": "3.0.0",
      "audio.sources": SESSION_SOURCES,
      "audio.timeline": { origin_unix_ms: origin },
    });
    await finish();
    expect(files()).toEqual([]);
    expect(uploads).toEqual([]);
    expect(r.metadata()).not.toHaveProperty(
      "contrib.livekit.audio.stop_reason",
    );
  });

  test("empty leading intervals are skipped and a late watermark drains without new input", async () => {
    const { r, finish, files } = recording(9600);
    r.record(packet(200));
    r.advance();
    await vi.waitFor(() => expect(uploads).toHaveLength(10));
    await finish();
    expect(files().map(([, , start, duration]) => [start, duration])).toEqual(
      Array.from({ length: 10 }, (_, i) => [200 + i * 100, 100]),
    );
  });

  test("holds delay cuts to a safe boundary and close flushes the remainder", async () => {
    const { r, finish, files } = recording(192000);
    r.record(packet(0, 72000));
    const hold = {};
    r.holds.set(hold, 1000);
    r.advance();
    expect(uploads).toHaveLength(0);
    r.holds.set(hold, 2000);
    r.advance();
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await finish();
    expect(files()).toEqual([
      ["part-0", "ready", 0, 2000],
      ["part-1", "ready", 2000, 1000],
    ]);
  });
});

describe("PII", () => {
  /** One exchange touching every PII-bearing native field, each marked SECRET. */
  async function exchange(sessionAttributes: Record<string, unknown> = {}) {
    const root = start("agent_session", undefined, sessionAttributes);
    const session: any = { sessionSpan: root };
    const user = start("user_turn", root);
    user.setAttributes({
      "lk.pii.user_transcript": "SECRET order 1042",
      "lk.pii.participant_identity": "SECRET-caller",
      "lk.participant_id": "PA_1",
      "lk.participant_kind": "SIP",
    });
    tracing.stt(
      { userTurnSpan: user, sttModel: "nova-3" },
      { type: 2, alternatives: [{ text: "SECRET order 1042" }] },
    );
    user.addEvent("gen_ai.user.message", { content: "SECRET" });
    user.addEvent("eou", { "lk.pii.text": "SECRET", "lk.eou.probability": 1 });
    user.end();
    const turn = start("agent_turn", root, {
      "lk.pii.user_input": "SECRET typed",
    });
    const lookup = {
      description: "SECRET tool description",
      parameters: { type: "object" },
    };
    tracing.scope(
      turn,
      () => {
        const model = start("llm_node", turn, {
          "lk.pii.chat_ctx": JSON.stringify({
            items: [
              { type: "message", id: "m1", role: "user", content: ["SECRET"] },
            ],
          }),
          "lk.pii.response.text": "SECRET reply",
          "gen_ai.request.model": "gpt-5.4-nano",
          "gen_ai.usage.input_tokens": 10,
        });
        model.end();
        const tool = start("function_tool", turn, {
          "lk.function_tool.name": "lookup_order",
          "lk.pii.function_tool.arguments": '{"id":"SECRET"}',
          "lk.pii.function_tool.output": '{"owner":"SECRET"}',
        });
        tool.recordException(new Error("SECRET: no such order"));
        tool.setStatus({ code: 2, message: "SECRET failure" });
        tool.end();
        start("tts_node", turn, { "lk.pii.input_text": "SECRET reply" }).end();
        const speaking = start("agent_speaking", turn);
        session.agentSpeakingSpan = speaking;
        tracing.conversation(session, {
          type: "message",
          id: "a1",
          role: "assistant",
          textContent: "SECRET reply",
        });
        speaking.end();
      },
      requestMetadata({
        span: turn,
        toolCtx: { functionTools: { lookup_order: lookup } },
        modelSettings: { toolChoice: "auto" },
      }),
    );
    turn.end();
    await tracing.closeSession(root);
    root.end();
    return rows();
  }

  test("by default LiveKit allows PII, so content is traced", async () => {
    const { one } = await exchange();
    expect(one("transcript_received").output).toEqual([
      { role: "user", content: "SECRET order 1042" },
    ]);
    expect(one("user_turn").input).toEqual([
      { role: "user", content: "SECRET order 1042" },
    ]);
    expect(one("llm_response").output).toEqual([
      { role: "assistant", content: "SECRET reply" },
    ]);
    expect(one("lookup_order").error).toContain("SECRET");
  });

  test.each([["false"], ["0"], ["no"], ["OFF"]])(
    "LIVEKIT_TELEMETRY_ALLOW_PII=%s omits everything from PII fields, keeping the trace's shape",
    async (value) => {
      vi.stubEnv("LIVEKIT_TELEMETRY_ALLOW_PII", value);
      const { all, one } = await exchange();
      expect(JSON.stringify(all)).not.toContain("SECRET");
      // The structure, models, usage, timing and identities remain.
      expect(all.map((r) => r.span_attributes.name).sort()).toEqual([
        "agent_speech",
        "agent_turn",
        "llm_response",
        "lookup_order",
        "session",
        "transcript_received",
        "tts",
        "user_turn",
      ]);
      expect(one("llm_response")).toMatchObject({
        metadata: { model: "gpt-5.4-nano" },
      });
      for (const name of ["user_turn", "agent_turn", "llm_response", "tts"])
        expect(one(name).input, name).toBeUndefined();
      for (const name of [
        "llm_response",
        "transcript_received",
        "agent_speech",
        "tts",
      ])
        expect(one(name).output, name).toBeUndefined();
      expect(one("transcript_received").metadata).toMatchObject({
        model: "nova-3",
      });
      expect(one("agent_speech").metadata).toMatchObject({
        "contrib.livekit.message_ids": ["a1"],
      });
      expect(one("user_turn").metadata["contrib.livekit.events"]).toEqual([
        {
          name: "eou",
          time_unix_ms: expect.any(Number),
          attributes: { "contrib.livekit.eou.probability": 1 },
        },
      ]);
      // A failure stays visible, without its details.
      expect(one("lookup_order").error).toBe("exception details redacted");
      expect(one("user_turn").metadata).toMatchObject({
        "contrib.livekit.participant_id": "PA_1",
        "contrib.livekit.participant_kind": "SIP",
      });
      expect(one("session").metadata["audio.participants"]).toBeUndefined();
    },
  );

  test("links resolved from PII payloads remain, holding only span IDs", async () => {
    vi.stubEnv("LIVEKIT_TELEMETRY_ALLOW_PII", "false");
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const first = start("llm_node", turn, {
      "lk.pii.response.function_calls": JSON.stringify([
        { call_id: "call-1", name: "lookup_order", arguments: "SECRET" },
      ]),
    });
    first.end();
    start("function_tool", turn, {
      "lk.function_tool.name": "lookup_order",
      "gen_ai.tool.call.id": "call-1",
      "lk.pii.function_tool.output": "SECRET",
    }).end();
    start("llm_node", turn, {
      "lk.pii.chat_ctx": JSON.stringify({
        items: [
          { type: "function_call_output", call_id: "call-1", output: "SECRET" },
        ],
      }),
    }).end();
    turn.end();
    const { all, named, one } = await rows();
    expect(JSON.stringify(all)).not.toContain("SECRET");
    const types = (row: any) =>
      (row.metadata.links ?? []).map(
        (l: any) => l.attributes["braintrust.relationship.type"],
      );
    expect(types(one("lookup_order"))).toEqual(["requested_by"]);
    expect(types(named("llm_response")[1])).toEqual(["consumes_tool_result"]);
  });

  test("LiveKit project redaction omits PII even when the env allows it", async () => {
    vi.stubEnv("LIVEKIT_TELEMETRY_ALLOW_PII", "true");
    tracing.jobContext = () => ({ _redactionEnabled: true });
    const { all } = await exchange();
    expect(JSON.stringify(all)).not.toContain("SECRET");
  });

  test("LiveKit's redaction flag on a span omits that span's PII", async () => {
    vi.stubEnv("LIVEKIT_TELEMETRY_ALLOW_PII", "true");
    const root = start("agent_session");
    start("llm_node", root, {
      "lk.redaction.enabled": true,
      "lk.pii.response.text": "SECRET reply",
    }).end();
    const { all, one } = await rows();
    expect(JSON.stringify(all)).not.toContain("SECRET");
    expect(one("llm_response").output).toBeUndefined();
  });

  test("LiveKit's redaction flag on the session omits PII from everything in it", async () => {
    vi.stubEnv("LIVEKIT_TELEMETRY_ALLOW_PII", "true");
    // Transcripts and replies have no native span of their own to carry it.
    const { all } = await exchange({ "lk.redaction.enabled": true });
    expect(JSON.stringify(all)).not.toContain("SECRET");
  });

  test("LiveKit's redaction flag counts when a span processor sets it at start", async () => {
    vi.stubEnv("LIVEKIT_TELEMETRY_ALLOW_PII", "true");
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const model = {
      ...nativeSpan(),
      attributes: { "lk.redaction.enabled": true },
    };
    // The reply's tools are published when the response wrapper starts.
    tracing.scope(
      turn,
      () =>
        tracing.observeSpan(model, {
          name: "llm_node",
          attributes: { "lk.pii.response.text": "SECRET reply" },
          startTime: [1, 0],
          context: { getValue: () => turn },
        }),
      requestMetadata({
        span: turn,
        toolCtx: {
          functionTools: {
            lookup_order: {
              description: "SECRET tool description",
              parameters: z.object({ id: z.number() }),
            },
          },
        },
        modelSettings: { toolChoice: "auto" },
      }),
    );
    model.end();
    turn.end();
    const { all, one } = await rows();
    expect(JSON.stringify(all)).not.toContain("SECRET");
    expect(one("llm_response").metadata.tools).toBeUndefined();
    expect(one("llm_response").metadata.tool_choice).toBeUndefined();
  });
});

describe("model ownership at the service boundary", () => {
  test.each(["llm", "stt", "tts"] as const)(
    "%s constructor options distinguish a hidden non-SDK client",
    async (kind) => {
      const root = start("agent_session");
      const native =
        kind === "stt"
          ? root
          : start(kind === "llm" ? "llm_node" : "tts_node", root);
      const method =
        kind === "llm" ? "chat" : kind === "stt" ? "recognize" : "synthesize";
      const execute = async () => {
        throw new Error("custom transport failure");
      };
      // The service does not expose its constructor-injected client afterward.
      const service = { [method]: execute };
      recordLiveKitOpenAIClient(
        service,
        { prototype: service },
        { client: { audio: {} } },
        kind,
      );
      await tracing.scope(native, async () => {
        await expect(
          tracing.model(
            execute,
            service,
            kind,
            method,
            [],
            { agentSession: { sessionSpan: root } },
            execute,
          ),
        ).rejects.toThrow("custom transport failure");
      });
      const captured = await rows();
      const model = captured.one(
        `livekit.${kind === "llm" ? "llm_response" : kind}`,
      );
      expect(model.error).toContain("custom transport failure");
      expect(model.span_parents).toEqual([
        captured.one(kind === "llm" ? "llm_response" : kind).span_id,
      ]);
    },
  );

  test.each([true, false])(
    "an exposed Anthropic SDK client retains provider ownership (wrapped=%s)",
    async (enabled) => {
      const root = start("agent_session");
      const native = start("llm_node", root);
      const raw = new Anthropic({
        apiKey: "unit",
        fetch: async () =>
          new Response(
            JSON.stringify({
              id: "unit",
              type: "message",
              role: "assistant",
              model: "unit-model",
              content: [{ type: "text", text: "hello" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 2, output_tokens: 1 },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      });
      const client = enabled ? wrapAnthropic(raw) : raw;
      await tracing.scope(native, () =>
        tracing.model(
          () =>
            client.messages.create({
              model: "unit-model",
              max_tokens: 2,
              messages: [{ role: "user", content: "hi" }],
            }),
          { client },
          "llm",
          "chat",
          [],
          { agentSession: { sessionSpan: root } },
        ),
      );
      const captured = await rows();
      expect(captured.named("livekit.llm_response")).toHaveLength(0);
      const provider = captured.named("anthropic.messages.create");
      expect(provider).toHaveLength(enabled ? 1 : 0);
      if (enabled) {
        expect(provider[0].span_parents).toEqual([
          captured.one("llm_response").span_id,
        ]);
        expect(provider[0].metrics.tokens).toBe(3);
      }
    },
  );

  test.each(["llm", "stt", "tts"] as const)(
    "%s shared service uses the executing session after its original session closes",
    async (kind) => {
      const first = start("agent_session");
      const activity = { agentSession: { sessionSpan: first } };
      const second = start("agent_session");
      const turn = start(kind === "stt" ? "user_turn" : "agent_turn", second);
      const native =
        kind === "stt"
          ? turn
          : start(kind === "llm" ? "llm_node" : "tts_node", turn);
      first.end();
      await tracing.closeSession(first);
      await tracing.scope(native, async () => {
        await Promise.resolve();
        await tracing.model(
          async () => ({ type: 2, alternatives: [{ text: "second session" }] }),
          { model: "shared", provider: "direct" },
          kind,
          kind === "llm" ? "chat" : kind === "stt" ? "recognize" : "synthesize",
          kind === "tts" ? ["second session"] : [],
          activity,
        );
      });
      const captured = await rows();
      const wrapper = captured.one(kind === "llm" ? "llm_response" : kind);
      const child = captured.one(
        `livekit.${kind === "llm" ? "llm_response" : kind}`,
      );
      expect(child.span_parents).toEqual([wrapper.span_id]);
      expect(child.root_span_id).toBe(wrapper.root_span_id);
      expect(wrapper.root_span_id).toBe(
        captured.named("session")[1].root_span_id,
      );
      if (kind === "stt")
        expect(wrapper.span_parents).toEqual([
          captured.one("user_turn").span_id,
        ]);
    },
  );

  for (const kind of ["llm", "stt", "tts"] as const) {
    for (const ownership of ["enabled", "disabled", "uncovered"] as const) {
      test(`${kind}: ${ownership} client owns its model payload and usage`, async () => {
        const root = start("agent_session");
        const turn = start(kind === "stt" ? "user_turn" : "agent_turn", root);
        const native =
          kind === "stt"
            ? turn
            : start(kind === "llm" ? "llm_node" : "tts_node", turn);
        const client = new OpenAI({
          apiKey: "unit-test",
          fetch: async () =>
            new Response(
              JSON.stringify(
                kind === "llm"
                  ? {
                      id: "unit",
                      choices: [
                        {
                          index: 0,
                          message: { role: "assistant", content: "hello" },
                          finish_reason: "stop",
                        },
                      ],
                      usage: {
                        prompt_tokens: 2,
                        completion_tokens: 1,
                        total_tokens: 3,
                      },
                    }
                  : { text: "hello" },
              ),
              { headers: { "content-type": "application/json" } },
            ),
        });
        const sdk = ownership === "enabled" ? wrapOpenAI(client) : client;
        const service = {
          model: "unit-model",
          provider: "openai",
          ...(ownership !== "uncovered" ? { client: sdk } : {}),
        };
        const activity = {
          agentSession: { sessionSpan: root },
          audioRecognition: { userTurnSpan: turn },
        };
        const method =
          kind === "llm" ? "chat" : kind === "stt" ? "recognize" : "synthesize";
        const result = { type: 2, alternatives: [{ text: "hello" }] };
        await tracing.scope(native, async () => {
          await tracing.model(
            async () => {
              if (ownership === "uncovered") return result;
              if (kind === "llm")
                return sdk.chat.completions.create({
                  model: "unit-model",
                  messages: [{ role: "user", content: "hi" }],
                });
              if (kind === "stt") {
                await sdk.audio.transcriptions.create({
                  model: "unit-model",
                  file: new File(["unit"], "unit.wav"),
                });
                return result;
              }
              const response = await sdk.audio.speech.create({
                model: "unit-model",
                voice: "alloy",
                input: "transformed text",
              });
              await response.arrayBuffer();
              return undefined;
            },
            service,
            kind,
            method,
            kind === "tts"
              ? ["transformed text"]
              : kind === "llm"
                ? [
                    {
                      chatCtx: {
                        toJSON: () => [{ role: "user", content: "hi" }],
                      },
                      toolCtx: {
                        functionTools: {
                          lookup: {
                            description: "Look up an order",
                            parameters: { type: "object" },
                          },
                        },
                      },
                      toolChoice: "auto",
                    },
                  ]
                : [],
            activity,
          );
        });
        const captured = await rows();
        const wrapper = captured.one(kind === "llm" ? "llm_response" : kind);
        expect(wrapper.span_attributes.type).toBe("task");
        expect(Object.keys(wrapper.metrics).sort()).toEqual(
          ["end", "start"].filter((k) => wrapper.metrics[k] !== undefined),
        );
        const children = captured.all.filter(
          (row) => row.span_attributes?.type === "llm",
        );
        expect(children).toHaveLength(ownership === "disabled" ? 0 : 1);
        for (const child of children)
          expect(child.span_parents).toEqual([wrapper.span_id]);
        if (ownership === "enabled" && kind === "llm") {
          expect(children[0].span_attributes.name).toBe("Chat Completion");
          expect(children[0].metrics.tokens).toBe(3);
        }
        if (ownership === "uncovered") {
          expect(children[0].span_attributes.name).toBe(
            `livekit.${kind === "llm" ? "llm_response" : kind}`,
          );
          if (kind === "llm") {
            expect(children[0].input).toEqual([
              { role: "user", content: "hi" },
            ]);
            expect(children[0].metadata).toMatchObject({
              tools: [
                {
                  type: "function",
                  function: {
                    name: "lookup",
                    description: "Look up an order",
                    parameters: { type: "object" },
                  },
                },
              ],
              tool_choice: "auto",
            });
          }
          if (kind === "tts")
            expect(children[0].input).toEqual({
              operation: "speech",
              prompt: "transformed text",
            });
          if (kind === "stt")
            expect(children[0].output).toEqual({
              content: [{ type: "text", text: "hello" }],
            });
        }
      });
    }
  }

  test("recognition starts before client execution and restores context after failure", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    const failure = new Error("recognizer failed");
    let during: string | undefined;
    await tracing.scope(turn, async () => {
      const before = currentSpan();
      await expect(
        tracing.model(
          async () => {
            during = currentSpan().spanId;
            now += 1000;
            throw failure;
          },
          { model: "direct", provider: "custom" },
          "stt",
          "recognize",
          [],
          {
            agentSession: { sessionSpan: root },
            audioRecognition: { userTurnSpan: turn },
          },
        ),
      ).rejects.toBe(failure);
      expect(currentSpan()).toBe(before);
    });
    const captured = await rows();
    expect(during).toBe(captured.one("stt").span_id);
    expect(captured.one("stt").metrics.end).toBeGreaterThanOrEqual(
      captured.one("stt").metrics.start,
    );
    expect(captured.one("livekit.stt").error).toContain("recognizer failed");
  });
});

describe("provider privacy across LiveKit scopes", () => {
  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "chat voice parts honor user=%s agent=%s within the framework policy",
    async (user, agent) => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
      vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", String(user));
      vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", String(agent));
      const root = start("agent_session");
      const client = wrapOpenAI(
        new OpenAI({
          apiKey: "unit",
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content: null,
                      audio: {
                        id: "audio-1",
                        data: "AQI=",
                        transcript: "hello",
                        expires_at: 1,
                      },
                    },
                  },
                ],
              }),
              { headers: { "content-type": "application/json" } },
            ),
        }),
      );
      await tracing.scope(
        root,
        async () =>
          await client.chat.completions.create({
            model: "unit",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "input_audio",
                    input_audio: { data: "AQI=", format: "wav" },
                  },
                ],
              },
            ],
          }),
      );
      const child = (await rows()).one("Chat Completion");
      expect(
        child.input[0].content[0].input_audio.data instanceof Attachment,
      ).toBe(user);
      expect(child.output[0].message.audio.data instanceof Attachment).toBe(
        agent,
      );
    },
  );

  test.each(["llm", "stt", "tts"] as const)(
    "%s provider errors retain application behavior without exporting redacted content",
    async (kind) => {
      const root = start("agent_session", undefined, {
        "lk.redaction.enabled": true,
      });
      const native =
        kind === "stt"
          ? root
          : start(kind === "llm" ? "llm_node" : "tts_node", root);
      const client = wrapOpenAI(
        new OpenAI({
          apiKey: "unit",
          maxRetries: 0,
          fetch: async () =>
            new Response(
              JSON.stringify({
                error: { message: "PRIVATE provider failure" },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            ),
        }),
      );
      await expect(
        tracing.scope(native, () =>
          tracing.model(
            () =>
              kind === "llm"
                ? client.chat.completions.create({
                    model: "unit",
                    messages: [{ role: "user", content: "PRIVATE input" }],
                  })
                : kind === "stt"
                  ? client.audio.transcriptions.create({
                      model: "unit",
                      file: new File(["PRIVATE audio"], "input.wav"),
                    })
                  : client.audio.speech.create({
                      model: "unit",
                      voice: "alloy",
                      input: "PRIVATE input",
                    }),
            { client, model: "unit", provider: "openai" },
            kind,
            kind === "llm"
              ? "chat"
              : kind === "stt"
                ? "recognize"
                : "synthesize",
            [],
            { agentSession: { sessionSpan: root } },
          ),
        ),
      ).rejects.toThrow("PRIVATE provider failure");
      const captured = await rows();
      expect(JSON.stringify(captured.all)).not.toContain("PRIVATE");
      const child = captured.all.find(
        (row) => row.span_attributes?.type === "llm",
      );
      expect(child).toBeDefined();
      expect(child.error).toBeUndefined();
      expect(child.metrics.end).toBeDefined();
    },
  );

  test.each(["environment", "job", "session"] as const)(
    "late %s redaction filters queued provider content after session cleanup",
    async (source) => {
      const root = start("agent_session");
      const job = { _redactionEnabled: false };
      // Capture the job object before starting the session, as a worker does.
      if (source === "job") {
        await tracing.shutdown();
        tracing = new LiveKitTracing(DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES);
        tracing.jobContext = () => job;
      }
      const session = source === "job" ? start("agent_session") : root;
      const client = wrapOpenAI(
        new OpenAI({
          apiKey: "unit",
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: { role: "assistant", content: "PRIVATE RESPONSE" },
                  },
                ],
                service_tier: "priority",
                usage: {
                  prompt_tokens: 2,
                  completion_tokens: 1,
                  total_tokens: 3,
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
        }),
      );
      await tracing.scope(
        session,
        async () =>
          await client.chat.completions.create({
            model: "unit",
            messages: [{ role: "user", content: "PRIVATE INPUT" }],
            tools: [
              {
                type: "function",
                function: { name: "lookup", description: "PRIVATE TOOL" },
              },
            ],
          }),
      );
      if (source === "environment")
        vi.stubEnv("LIVEKIT_TELEMETRY_ALLOW_PII", "false");
      if (source === "job") job._redactionEnabled = true;
      if (source === "session")
        session.setAttribute("lk.redaction.enabled", true);
      session.end();
      await tracing.closeSession(session);
      const captured = await rows();
      expect(JSON.stringify(captured.all)).not.toContain("PRIVATE");
      const provider = captured.one("Chat Completion");
      expect(provider.metadata).toEqual({
        model: "unit",
        provider: "openai",
        served_service_tier: "priority",
      });
      expect(provider.metrics.tokens).toBe(3);
      expect(provider.input).toBeUndefined();
      expect(provider.output).toBeUndefined();
    },
  );

  test("concurrent session privacy does not filter unrelated provider or manual spans", async () => {
    const privateRoot = start("agent_session", undefined, {
      "lk.redaction.enabled": true,
    });
    const publicRoot = start("agent_session");
    const client = wrapOpenAI(
      new OpenAI({
        apiKey: "unit",
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "answer" },
                  finish_reason: "stop",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }),
    );
    const params = {
      model: "unit",
      messages: [{ role: "user" as const, content: "question" }],
    };
    await Promise.all([
      tracing.scope(privateRoot, async () => {
        const manual = currentSpan().startSpan({
          name: "customer",
          event: { input: "customer data" },
        });
        manual.end();
        await client.chat.completions.create(params);
      }),
      tracing.scope(
        publicRoot,
        async () => await client.chat.completions.create(params),
      ),
      client.chat.completions.create(params),
    ]);
    const captured = await rows();
    const providers = captured.named("Chat Completion");
    expect(providers).toHaveLength(3);
    expect(providers.filter((p) => p.input)).toHaveLength(2);
    expect(captured.one("customer").input).toBe("customer data");
  });
});

describe("model streaming lifecycle", () => {
  test("continuous recognition stays at session scope across user turns", async () => {
    const root = start("agent_session");
    const firstTurn = start("user_turn", root);
    const recognition: { userTurnSpan?: NativeSpan } = {
      userTurnSpan: firstTurn,
    };
    const during: string[] = [];
    const activity = {
      agentSession: { sessionSpan: root },
      audioRecognition: recognition,
    };
    const original = {
      async *[Symbol.asyncIterator]() {
        during.push(currentSpan().spanId);
        now += 500;
        yield { type: 2, alternatives: [{ text: "first turn" }] };
        during.push(currentSpan().spanId);
        now += 1000;
        yield { type: 2, alternatives: [{ text: "second turn" }] };
        yield {
          type: 4,
          recognitionUsage: { inputTokens: 5, outputTokens: 2 },
        };
      },
    };
    const stream = tracing.scope(firstTurn, () =>
      tracing.model(
        () => original,
        { model: "transcriber", provider: "custom" },
        "stt",
        "stream",
        [],
        activity,
      ),
    );
    expect(stream).toBe(original);
    let secondTurn: NativeSpan | undefined;
    const before = currentSpan();
    for await (const event of stream) {
      if (event.type !== 2) continue;
      if (
        secondTurn === undefined &&
        event.alternatives?.[0].text === "second turn"
      ) {
        firstTurn.end();
        secondTurn = start("user_turn", root);
        recognition.userTurnSpan = secondTurn;
      }
      tracing.stt(recognition, event);
    }
    secondTurn?.end();
    expect(currentSpan()).toBe(before);
    const captured = await rows();
    const session = captured.one("session");
    const model = captured.one("livekit.stt.stream");
    expect(captured.named("stt")).toHaveLength(0);
    expect(captured.named("livekit.stt")).toHaveLength(0);
    expect(model.span_attributes.type).toBe("llm");
    expect(model.span_parents).toEqual([session.span_id]);
    expect(model.metadata).toMatchObject({
      "audio.scope": "session",
      "audio.source_id": "session-input",
      model: "transcriber",
      provider: "custom",
    });
    expect(model.metadata).not.toHaveProperty("turn.id");
    expect(model.metadata).not.toHaveProperty("turn.reply_to");
    expect(model.metrics).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 2,
      tokens: 7,
    });
    expect(model.metrics.end).toBeGreaterThan(model.metrics.start);
    expect(model.output).toEqual({
      content: [{ type: "text", text: "first turn second turn" }],
    });
    expect(during).toEqual([session.span_id, session.span_id]);
    expect(
      captured.named("transcript_received").map((row) => row.span_parents),
    ).toEqual(captured.named("user_turn").map((row) => [row.span_id]));
    expect(session.input).toBeUndefined();
    expect(session.output).toBeUndefined();
    expect(session.metadata).not.toHaveProperty("model");
    expect(session.metadata).not.toHaveProperty("provider");
  });

  test("a failed recognition stream ends its model and restores the caller scope", async () => {
    const root = start("agent_session");
    const turn = start("user_turn", root);
    const error = new Error("stream connection failed");
    tracing.scope(turn, () => {
      const before = currentSpan();
      expect(() =>
        tracing.model(
          () => {
            throw error;
          },
          { provider: "custom" },
          "stt",
          "stream",
          [],
          {
            agentSession: { sessionSpan: root },
            audioRecognition: { userTurnSpan: turn },
          },
        ),
      ).toThrow(error);
      expect(currentSpan()).toBe(before);
    });
    const captured = await rows();
    const model = captured.one("livekit.stt.stream");
    expect(model.span_parents).toEqual([captured.one("session").span_id]);
    expect(model.error).toContain(error.message);
    expect(model.metrics.end).toBeDefined();
    expect(captured.named("stt")).toHaveLength(0);
    expect(captured.one("session").error).toBeUndefined();
  });

  test("concurrent recognition streams keep session ownership and redaction isolated", async () => {
    const roots = [
      start("agent_session"),
      start("agent_session", undefined, { "lk.redaction.enabled": true }),
    ];
    const before = currentSpan();
    await Promise.all(
      roots.map(async (root, index) => {
        const turn = start("user_turn", root);
        const stream = tracing.scope(turn, () =>
          tracing.model(
            () =>
              (async function* () {
                await Promise.resolve();
                yield {
                  type: 2,
                  alternatives: [
                    {
                      text: index ? "PRIVATE TRANSCRIPT" : "public transcript",
                    },
                  ],
                };
                yield {
                  type: 4,
                  recognitionUsage: { inputTokens: 2 + index, outputTokens: 1 },
                };
              })(),
            { model: `model-${index}`, provider: "custom" },
            "stt",
            "stream",
            [],
            {
              agentSession: { sessionSpan: root },
              audioRecognition: { userTurnSpan: turn },
            },
          ),
        );
        for await (const _ of stream) {
          /* consume */
        }
      }),
    );
    expect(currentSpan()).toBe(before);
    const captured = await rows();
    const sessions = captured.named("session");
    const models = captured.named("livekit.stt.stream");
    expect(models).toHaveLength(2);
    expect(captured.named("stt")).toHaveLength(0);
    for (let index = 0; index < models.length; index++) {
      expect(models[index].span_parents).toEqual([sessions[index].span_id]);
      expect(models[index].metadata["audio.scope"]).toBe("session");
      expect(models[index].metadata).not.toHaveProperty("turn.id");
      expect(models[index].metrics.tokens).toBe(3 + index);
      expect(sessions[index].input).toBeUndefined();
      expect(sessions[index].output).toBeUndefined();
    }
    expect(models[0].output).toEqual({
      content: [{ type: "text", text: "public transcript" }],
    });
    expect(models[1].output).toBeUndefined();
    expect(JSON.stringify(captured.all)).not.toContain("PRIVATE TRANSCRIPT");
  });

  for (const kind of ["llm", "stt", "tts"] as const) {
    test(`${kind} keeps one model request across chunks and separate retry attempts`, async () => {
      const root = start("agent_session");
      const native =
        kind === "stt"
          ? root
          : start(kind === "llm" ? "llm_node" : "tts_node", root);
      const activity = { agentSession: { sessionSpan: root } };
      const stream = {
        run() {},
        async *[Symbol.asyncIterator]() {
          if (kind === "llm") {
            yield { delta: { content: "hel" } };
            yield {
              delta: { content: "lo" },
              usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
            };
          } else if (kind === "stt") {
            yield { type: 2, alternatives: [{ text: "hello" }] };
            yield { type: 2, alternatives: [{ text: "again" }] };
            yield {
              type: 4,
              recognitionUsage: { inputTokens: 3, outputTokens: 1 },
            };
            yield {
              type: 4,
              recognitionUsage: { inputTokens: 2, outputTokens: 1 },
            };
          } else {
            yield { frame: frame() };
            yield { frame: frame() };
          }
        },
      };
      const observed = tracing.scope(native, () =>
        tracing.model(
          () => stream,
          { model: "direct", provider: "openai" },
          kind,
          kind === "llm" ? "chat" : "stream",
          [],
          activity,
        ),
      );
      expect(observed).toBe(stream);
      const error = new Error("first request failed");
      await expect(
        tracing.modelRun(stream, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      await tracing.modelRun(stream, async () => {});
      for await (const _ of observed) {
        /* consume without prefetch */
      }
      const captured = await rows();
      const children = captured.named(
        `livekit.${kind === "llm" ? "llm_response" : kind === "stt" ? "stt.stream" : kind}`,
      );
      expect(children).toHaveLength(2);
      expect(children[0].error).toContain("first request failed");
      expect(children[1].error).toBeUndefined();
      if (kind === "llm") {
        expect(children[1].output).toEqual([
          { index: 0, message: { role: "assistant", content: "hello" } },
        ]);
        expect(children[1].metrics.tokens).toBe(5);
      }
      if (kind === "stt") {
        expect(children[1].output).toEqual({
          content: [{ type: "text", text: "hello again" }],
        });
        expect(children[1].metrics).toMatchObject({
          prompt_tokens: 5,
          completion_tokens: 2,
          tokens: 7,
        });
        expect(children[0].metrics.tokens).toBeUndefined();
      }
      expect(children[1].metrics.time_to_first_token).toBeGreaterThanOrEqual(0);
    });
  }

  test.each(["llm", "stt", "tts"] as const)(
    "%s attributes buffered chunks to their producing attempt",
    async (kind) => {
      if (kind === "tts") {
        vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
        // This checks exact samples per attempt, independently of whether the
        // optional codec package is installed and enables default compression.
        tracing = new LiveKitTracing(
          DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES,
          undefined,
          true,
          { codec: { name: "pcm" } },
        );
      }
      const root = start("agent_session");
      const native =
        kind === "stt"
          ? root
          : start(kind === "llm" ? "llm_node" : "tts_node", root);
      const queued: unknown[] = [];
      const stream = {
        queue: {
          put(value: unknown) {
            queued.push(value);
          },
        },
        run() {},
        async *[Symbol.asyncIterator]() {
          yield* queued;
        },
      };
      const remove = livekitChannels.modelEnqueue.intercept(
        (target, self, args, { stream }) => {
          const result = Reflect.apply(target, self, args);
          tracing.modelEnqueue(stream, args[0]);
          return result;
        },
      );
      const observed = tracing.scope(native, () =>
        tracing.model(
          () => stream,
          { model: "custom" },
          kind,
          kind === "llm" ? "chat" : "stream",
          [],
          { agentSession: { sessionSpan: root } },
        ),
      );
      const emit = (text: string, tokens: number) => {
        stream.queue.put(
          kind === "llm"
            ? {
                delta: { content: text },
                usage: {
                  promptTokens: tokens,
                  completionTokens: 1,
                  totalTokens: tokens + 1,
                  promptCachedTokens: tokens - 1,
                  reasoningTokens: 0,
                  cacheCreationTokens: 0,
                  serviceTier: text === "FIRST" ? " FIRST " : undefined,
                },
              }
            : kind === "stt"
              ? { type: 2, alternatives: [{ text }] }
              : { frame: frame(480, tokens) },
        );
      };
      try {
        await expect(
          tracing.modelRun(stream, async () => {
            emit("FIRST", 3);
            throw new Error("retry");
          }),
        ).rejects.toThrow("retry");
        await tracing.modelRun(stream, async () => {
          emit("SECOND", 5);
        });
        for await (const _ of observed) {
          /* intentionally read after both attempts */
        }
        const children = (await rows()).named(
          `livekit.${kind === "llm" ? "llm_response" : kind === "stt" ? "stt.stream" : kind}`,
        );
        expect(children).toHaveLength(2);
        expect(children[0].error).toContain("retry");
        expect(children[1].error).toBeUndefined();
        if (kind === "llm") {
          expect(
            children.map((child) => child.output[0].message.content),
          ).toEqual(["FIRST", "SECOND"]);
          expect(children.map((child) => child.metrics.tokens)).toEqual([4, 6]);
          expect(
            children.map((child) => child.metrics.prompt_cached_tokens),
          ).toEqual([2, 4]);
          expect(
            children.map((child) => child.metadata.served_service_tier),
          ).toEqual(["first", undefined]);
        } else if (kind === "stt") {
          expect(children.map((child) => child.output.content[0].text)).toEqual(
            ["FIRST", "SECOND"],
          );
        }
        if (kind === "tts") {
          for (const child of children)
            expect(child.output.content[0].file.byte_size).toBe(
              frame().data.byteLength,
            );
          const samples = await Promise.all(
            children.map(async (child) => {
              const data = await child.output.content[0].file.file_data.data();
              return new Int16Array(await data.arrayBuffer())[0];
            }),
          );
          expect(samples).toEqual([3, 5]);
        }
        for (const child of children) {
          expect(child.metrics.time_to_first_token).toBeGreaterThanOrEqual(0);
          expect(child.metrics.end).toBeDefined();
        }
      } finally {
        remove();
      }
    },
  );

  test("fallback usage preserves reasoning, cache details and the reported service tier", async () => {
    const root = start("agent_session");
    const native = start("llm_node", root);
    const stream = tracing.scope(native, () =>
      tracing.model(
        () =>
          (async function* () {
            yield {
              usage: {
                promptTokens: 10,
                completionTokens: 6,
                totalTokens: 16,
                promptCachedTokens: 3,
                cacheCreationTokens: 2,
                reasoningTokens: 4,
                serviceTier: " PRIORITY ",
              },
            };
            yield { delta: { content: "answer" }, usage: { serviceTier: "" } };
          })(),
        { model: "custom" },
        "llm",
        "chat",
        [],
        { agentSession: { sessionSpan: root } },
      ),
    );
    for await (const _ of stream) {
      /* consume */
    }
    const model = (await rows()).one("livekit.llm_response");
    expect(model.metrics).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 6,
      tokens: 16,
      prompt_cached_tokens: 3,
      prompt_cache_creation_tokens: 2,
      completion_reasoning_tokens: 4,
    });
    expect(model.metadata.served_service_tier).toBe("priority");
  });

  test("fallback omits unavailable usage details and service tier", async () => {
    const root = start("agent_session");
    const native = start("llm_node", root);
    const stream = tracing.scope(native, () =>
      tracing.model(
        () =>
          (async function* () {
            yield { delta: { content: "answer" } };
          })(),
        {},
        "llm",
        "chat",
        [],
        { agentSession: { sessionSpan: root } },
      ),
    );
    for await (const _ of stream) {
      /* consume */
    }
    const model = (await rows()).one("livekit.llm_response");
    for (const field of [
      "prompt_tokens",
      "completion_tokens",
      "tokens",
      "prompt_cached_tokens",
      "prompt_cache_creation_tokens",
      "completion_reasoning_tokens",
    ])
      expect(model.metrics[field]).toBeUndefined();
    expect(model.metadata.served_service_tier).toBeUndefined();
  });

  test("cancelled and abandoned recognizers end once, including at session shutdown", async () => {
    const root = start("agent_session");
    let generated = 0;
    const activity = { agentSession: { sessionSpan: root } };
    const stream = tracing.model(
      () =>
        (async function* () {
          generated++;
          yield { type: 2, alternatives: [{ text: "first" }] };
          generated++;
          yield { type: 2, alternatives: [{ text: "second" }] };
        })(),
      { model: "direct", provider: "custom" },
      "stt",
      "stream",
      [],
      activity,
    );
    for await (const _ of stream) break;
    expect(generated).toBe(1);
    tracing.model(
      () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 2 };
        },
      }),
      { provider: "custom" },
      "stt",
      "stream",
      [],
      activity,
    );
    await tracing.closeSession(root);
    const captured = await rows();
    expect(captured.named("stt")).toHaveLength(0);
    expect(captured.named("livekit.stt.stream")).toHaveLength(2);
    for (const row of captured.named("livekit.stt.stream"))
      expect(row.metrics.end).toBeDefined();
  });
});

test("continuous STT never copies frames even when both voice capture flags are enabled", async () => {
  vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
  const root = start("agent_session");
  const activity = { agentSession: { sessionSpan: root } } as any;
  const pushFrame = vi.fn();
  const original = {
    pushFrame,
    async *[Symbol.asyncIterator]() {
      yield { type: 2, alternatives: [{ text: "hello" }] };
    },
  };
  const stream = tracing.scope(root, () =>
    tracing.model(
      () => original,
      { provider: "direct", model: "transcriber" },
      "stt",
      "stream",
      [],
      activity,
    ),
  );
  const data = new Int16Array([1, 2, 3, 4]);
  const readData = vi.fn(() => data);
  const frame = { data, sampleRate: 24000, channels: 1, samplesPerChannel: 4 };
  stream.pushFrame(frame);
  for await (const _ of stream) {
    /* consume */
  }
  expect(pushFrame).toHaveBeenCalledWith(frame);
  expect(readData).not.toHaveBeenCalled();
  const captured = await rows();
  const model = captured.one("livekit.stt.stream");
  expect(model.input).toEqual({ operation: "transcribe" });
  expect(model.output).toEqual({ content: [{ type: "text", text: "hello" }] });
  expect(model.metadata).not.toHaveProperty("contrib.livekit.audio.segments");
});
