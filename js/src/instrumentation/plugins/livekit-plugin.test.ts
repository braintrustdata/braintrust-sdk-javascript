/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod/v3";
import { configureNode } from "../../node/config";
import {
  Attachment,
  _exportsForTestingOnly as logging,
  initLogger,
} from "../../logger";
import type { LiveKitSpan, SpanTime } from "../../vendor-sdk-types/livekit";
import { DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES } from "../config";
import { channel, defineInterceptor } from "../core/interceptor-definitions";
import { traceAsyncCall } from "../core/tracing";
import { _exportsForTestingOnly } from "./livekit-plugin";

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
  vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "");
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
const channelSamples = (bytes: Uint8Array, channel: number) => {
  const view = new DataView(bytes.buffer);
  return Array.from({ length: bytes.length / 4 }, (_, i) =>
    view.getInt16((i * 2 + channel) * 2, true),
  );
};

describe("tracing", () => {
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
    // Native request spans fold into the model span, contributing usage.
    const request = start("llm_request", model, {
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 3,
    });
    // Attempts export under the model span. A retried attempt's failure does
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
      span_attributes: { type: "llm" },
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
        prompt_tokens: 10,
        completion_tokens: 3,
        tokens: 13,
        time_to_first_token: 0.2,
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

  test("links requests, tool results, input speech, transcripts and generated speech", async () => {
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
    caller.end();
    user.end();
    tracing.conversation(
      { sessionSpan: root },
      {
        type: "message",
        id: "caller",
        role: "user",
        textContent: "Order?",
        metrics: { startedSpeakingAt: 1 },
      },
    );
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
      tracing.inference(() => {
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
      });
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
    const stt = one("stt");
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
    expect(one("user_speech").metadata.links).toEqual([
      link(stt, "transcribed_by"),
    ]);
    expect(first.metadata.links).toEqual([
      link(one("user_speech"), "input_context"),
    ]);
    expect(one("lookup_order").metadata.links).toEqual([
      link(first, "requested_by"),
    ]);
    expect(second.metadata.links).toEqual([
      link(one("lookup_order"), "consumes_tool_result"),
    ]);
    expect(one("tts").metadata.links).toEqual([link(second, "generated_by")]);
    expect(one("agent_speech").metadata.links).toEqual([
      link(second, "generated_by"),
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
      expect(tracing.sessions.size).toBe(0);

      const { all } = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        span_attributes: { name: "session" },
        error: "failed",
        metrics: { start: 2.5, end: 2.5 },
        metadata: {
          model: "test-model",
          ["__proto__"]: "safe",
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
    const wait = start("eou_wait", turn);
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
      "livekit.eou_wait": "user_turn",
      "livekit.eou_detection": "livekit.eou_wait",
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
    // LiveKit can leave internal spans such as eou_wait open. They don't hold
    // the session, but still export if LiveKit ends them later.
    const wait = start("eou_wait", turn);
    turn.end([2, 0]);
    root.end([2, 0]);
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
      span_parents: [one("agent_turn").span_id],
      metrics: { end: 4 },
    });
  });

  test("sessions inherit the current Braintrust parent", async () => {
    const outer = start("agent_session");
    tracing.scope(outer, () => start("agent_session"));
    const [first, second] = (await rows()).named("session");
    expect(second.span_parents).toEqual([first.span_id]);
  });

  test("inference suppression preserves results and leaves provider calls in user tools visible", async () => {
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
          await tracing.inference(async () => {
            await Promise.resolve();
            return request();
          }),
        ).toBe("answer");
        expect(await request()).toBe("answer"); // e.g. a provider call inside a user tool
      });
    } finally {
      unsubscribe();
    }
    expect((await rows()).named("provider-request")).toHaveLength(1);
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

describe("speech", () => {
  test("native speech owns overlap, late transcript timing and session ownership", async () => {
    const root = start("agent_session");
    const agent = start("agent_speaking", root);
    const caller = start("user_speaking", root, {}, [3, 0]);
    caller.end([4, 0]);
    const session = { sessionSpan: root };
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
    const { one } = await rows();
    expect(one("user_speech")).toMatchObject({
      span_parents: [one("session").span_id],
      metrics: { start: 3, end: 4 },
      input: [{ role: "user", content: "Wait, order 1042" }],
      metadata: { "contrib.livekit.message_ids": ["late"] },
    });
    expect(one("agent_speech")).toMatchObject({
      metrics: { start: 1, end: 6 },
      output: [{ role: "assistant", content: "It arrives Friday." }],
    });
  });

  test("typed input is not attributed to an earlier untranscribed speech interval", async () => {
    const root = start("agent_session");
    start("user_speaking", root).end([2, 0]);
    tracing.conversation(
      { sessionSpan: root },
      { type: "message", id: "typed", role: "user", textContent: "Typed" },
    );
    root.end([3, 0]);
    const { one } = await rows();
    expect(one("user_speech").input).toBeUndefined();
    expect(
      one("session").metadata["contrib.livekit.unassociated_messages"],
    ).toEqual([{ id: "typed", role: "user", text: "Typed" }]);
  });

  test("native recognition ownership survives independently sampled speech timestamps", async () => {
    const root = start("agent_session");
    const user = start("user_turn", root);
    start("user_speaking", user, {}, [1, 5_000_000]).end([2, 0]);
    const session = { sessionSpan: root };
    tracing.userTurn(
      { agentSession: session },
      { userTurnSpan: user, startedSpeakingAt: 1000, stoppedSpeakingAt: 2000 },
    );
    tracing.conversation(session, {
      type: "message",
      id: "caller",
      role: "user",
      textContent: "Where is my order?",
      metrics: { startedSpeakingAt: 1 },
    });
    expect((await rows()).one("user_speech")).toMatchObject({
      metrics: { start: 1.005 },
      input: [{ role: "user", content: "Where is my order?" }],
    });
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

  test.each([undefined, "", "Heard prefix"])(
    "interrupted speech uses only synchronized playback text (%j)",
    async (synchronizedTranscript) => {
      const { sink, session } = speakingSession();
      sink.emit("playbackFinished", {
        interrupted: true,
        synchronizedTranscript,
      });
      tracing.conversation(session, {
        type: "message",
        id: "answer",
        role: "assistant",
        textContent: "Heard prefix and unheard suffix",
        interrupted: true,
      });
      expect((await rows()).one("agent_speech").output).toEqual(
        synchronizedTranscript === undefined
          ? undefined
          : [{ role: "assistant", content: synchronizedTranscript }],
      );
    },
  );

  test("replaced outputs stop reporting heard text; a verified prefix is kept", async () => {
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
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
  });
  /** A recorded session with one agent turn and an EventEmitter sink. */
  function session(
    captureFrame: (
      sink: EventEmitter,
    ) => (frame: unknown) => Promise<unknown> = () => async () => {},
  ) {
    const root = start("agent_session");
    const turn = start("agent_turn", root);
    const sink: any = new EventEmitter();
    Object.assign(sink, {
      captureFrame: captureFrame(sink),
      flush() {},
      clearBuffer() {},
    });
    const agentSession: any = {
      sessionSpan: root,
      activity: { currentSpeech: { _agentTurnSpan: turn } },
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
        turn.end();
        await tracing.closeSession(root);
        root.end();
        const result = await rows();
        const recordings =
          result.named("session")[0].metadata?.["audio.recordings"];
        const selections = (name: string) =>
          result
            .one(name)
            .metadata?.[
              "audio.selections"
            ]?.map((s: any) => [s.recording_id, s.start_offset_ms, s.end_offset_ms]);
        return { ...result, recordings, selections };
      },
    };
  }

  test("disabled attachment capture leaves sinks and inputs untouched", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "");
    const stream = new ReadableStream();
    const { getReader } = stream;
    const { sink, session: agentSession, close } = session();
    const { captureFrame } = sink;
    tracing.input({ agentSession }, stream);
    tracing.output(agentSession);
    expect(stream.getReader).toBe(getReader);
    expect(sink.captureFrame).toBe(captureFrame);
    expect((await close()).recordings).toBeUndefined();
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
    const recordings = (await rows()).named("session")[0].metadata?.[
      "audio.recordings"
    ];
    expect(recordings).toMatchObject([{ id: "call-0000", state: "ready" }]);
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
    const recordings = (await rows()).named("session")[0].metadata?.[
      "audio.recordings"
    ];
    expect(recordings).toBeDefined();
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
    const { recordings, selections, one } = await close();
    expect(recordings).toMatchObject([
      {
        id: "call-0000",
        state: "ready",
        duration_ms: 80,
        sources: [{ channel_index: 1 }],
        timeline: { origin_unix_ms: origin, recording_start_offset_ms: 0 },
      },
    ]);
    expect(selections("agent_turn")).toEqual([
      ["call-0000", 10, 30],
      ["call-0000", 60, 80],
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
    expect((await close()).selections("agent_turn")).toEqual([
      ["call-0000", 10, 30],
    ]);
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
    expect((await close()).recordings).toEqual([
      {
        id: "call",
        recording_group_id: "call",
        state: "omitted",
        reason,
        truncated: true,
      },
    ]);
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
    expect((await close()).recordings).toMatchObject([
      { reason: "capture_byte_limit" },
    ]);
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
          "audio.recordings": [{ reason: "shared_output_unsupported" }],
        },
      },
      {
        metadata: {
          "audio.recordings": [{ reason: "shared_output_unsupported" }],
        },
      },
    ]);
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
      named("agent_speech").map((r) =>
        r.metadata["audio.selections"].map((s: any) => s.start_offset_ms),
      ),
    ).toEqual([[10], [100]]);
    expect(selections("agent_turn")).toEqual([
      ["call-0000", 10, 30],
      ["call-0000", 100, 120],
    ]);
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
    const { recordings, selections } = await close();
    expect(recordings).toMatchObject([{ id: "call-0000", duration_ms: 20 }]);
    expect(selections("agent_turn")).toEqual([["call-0000", 0, 20]]);
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

  test("user turns and speech select only captured input", async () => {
    const { root, session: agentSession, origin, close } = session();
    const user = start("user_turn", root);
    const speech = start("user_speaking", user, {}, origin + 5);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(frame(2400));
      },
    });
    tracing.input({ agentSession }, stream);
    now = origin + 100;
    await stream.getReader().read();
    tracing.userTurn(
      { agentSession },
      {
        userTurnSpan: user,
        startedSpeakingAt: origin - 50,
        stoppedSpeakingAt: origin + 40,
      },
    );
    speech.end(origin + 500);
    user.end();
    const { selections } = await close();
    expect(selections("user_turn")).toEqual([["call-0000", 0, 40]]);
    expect(selections("user_speech")).toEqual([["call-0000", 5, 100]]);
  });

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
      .map((r) => r.metadata["audio.recordings"][0].reason);
    expect(reasons).toEqual([
      "shared_input_unsupported",
      "shared_input_unsupported",
      "input_source_change_unsupported",
    ]);
  });
});

describe("recording files", () => {
  const packet = (at: number, length = 24000, channel = 0) => ({
    pcm: Int16Array.from({ length }, (_, i) => ((i * 31) % 30000) - 15000),
    at,
    rate: 24000,
    channels: 1,
    channel,
  });
  /** A recording whose wall-clock hold no longer limits uploads. */
  function recording(chunkBytes = DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES) {
    const log = vi.fn();
    const turn = vi.fn();
    const r = new Recording({ spanId: "root", log } as any, chunkBytes, (id) =>
      id === "turn" ? ({ span: { log: turn } } as any) : undefined,
    );
    now += 3_600_000;
    const last = (fn: typeof log, key: string) =>
      fn.mock.calls
        .map(([event]) => event.metadata?.[key])
        .filter(Boolean)
        .at(-1);
    return {
      r,
      log,
      files: () =>
        (last(log, "audio.recordings") as any[]).map((f) => [
          f.id,
          f.state,
          f.timeline?.recording_start_offset_ms,
          f.duration_ms,
        ]),
      selections: () =>
        (last(turn, "audio.selections") as any[])?.map((s) => [
          s.recording_id,
          s.start_offset_ms,
          s.end_offset_ms,
        ]),
    };
  }
  test("publishes attachment references and selections only after upload succeeds", async () => {
    let complete!: () => void;
    const blocked = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.mocked(Attachment.prototype.upload).mockImplementation(async () => {
      await blocked;
      return { upload_status: "done" };
    });
    const { r, log, files, selections } = recording(96000);
    r.select("turn", 0, 1000, 0);
    r.publish(["turn"]);
    r.record(packet(0));
    r.advance();
    expect(files()).toEqual([["call-0000", "pending", 0, undefined]]);
    expect(log.mock.calls.some(([event]) => event.input)).toBe(false);
    expect(selections()).toEqual([]);
    complete();
    await r.finish();
    expect(files()).toEqual([["call-0000", "ready", 0, 1000]]);
    expect(
      log.mock.calls.some(([event]) => event.input?.audio?.["call-0000"]),
    ).toBe(true);
    expect(selections()).toEqual([["call-0000", 0, 1000]]);
  });

  test("progressive digests reconstruct both sources exactly across file boundaries", async () => {
    const { r, files } = recording(96000);
    const length = 3 * 24000 + 1777;
    const expected = Buffer.alloc(length * 4);
    for (let at = 0; at < length; at += 719) {
      for (let channel = 0; channel < 2; channel++) {
        const pcm = Int16Array.from(
          { length: Math.min(719, length - at) },
          (_, i) => (((i + at) * (channel ? 31 : 17)) % 30001) - 15000,
        );
        expect(
          r.record({ pcm, at: at / 24, rate: 24000, channels: 1, channel }),
        ).toBe(true);
        for (let i = 0; i < pcm.length; i++)
          expected.writeInt16LE(pcm[i], ((at + i) * 2 + channel) * 2);
      }
      r.advance();
    }
    await vi.waitFor(() => expect(uploads).toHaveLength(3));
    await r.finish();
    expect(uploads.map((f) => f.length / 4)).toEqual([
      24000, 24000, 24000, 1777,
    ]);
    expect(Buffer.concat(uploads)).toEqual(expected);
    expect(files().map(([id]) => id)).toEqual([
      "call-0000",
      "call-0001",
      "call-0002",
      "call-0003",
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
    const { r, files } = recording(8 * 1024 * 1024);
    const samples = 2 * 1024 * 1024;
    r.record(packet(0, samples));
    r.advance();
    for (let i = 1; i <= 9; i++) r.record(packet((i * samples) / 24, samples));
    expect(r.reason).toBe("capture_byte_limit");
    complete();
    await r.finish();
    expect(files().map(([, state]) => state)).toEqual([
      ...Array(9).fill("ready"),
      "omitted",
    ]);
  });

  test("a failed upload omits its file and selections without invalidating earlier files", async () => {
    vi.mocked(Attachment.prototype.upload)
      .mockResolvedValueOnce({ upload_status: "done" })
      .mockResolvedValueOnce({
        upload_status: "error",
        error_message: "offline",
      });
    const { r, files, selections } = recording(96000);
    r.select("turn", 0, 2000, 0);
    for (let i = 0; i < 2; i++) {
      r.record(packet(i * 1000));
      r.advance();
      await vi.waitFor(() =>
        expect(Attachment.prototype.upload).toHaveBeenCalledTimes(i + 1),
      );
    }
    await r.finish();
    expect(files()).toEqual([
      ["call-0000", "ready", 0, 1000],
      ["call-0001", "omitted", 1000, undefined],
      ["call", "omitted", undefined, undefined],
    ]);
    expect(r.reason).toBe("recording_export_failed");
    expect(selections()).toEqual([["call-0000", 0, 1000]]);
  });

  test("late selections split across ready files and merge adjacent intervals", async () => {
    const { r, selections } = recording(96000);
    r.record(packet(0, 48000));
    await r.finish();
    r.select("turn", 500, 1000, 1);
    r.select("turn", 1000, 1500, 1);
    r.publish(["turn"]);
    expect(selections()).toEqual([
      ["call-0000", 500, 1000],
      ["call-0001", 0, 500],
    ]);
  });

  test("the duration limit keeps accepted audio and finish is idempotent", async () => {
    const { r, files } = recording();
    expect(r.record(packet(0))).toBe(true);
    expect(r.record(packet(30 * 60 * 1000 - 500))).toBe(false);
    const finishing = r.finish();
    expect(r.finish()).toBe(finishing);
    await finishing;
    expect(r.reason).toBe("duration_limit");
    expect(files()).toEqual([
      ["call-0000", "ready", 0, 1000],
      ["call", "omitted", undefined, undefined],
    ]);
    expect(r.record(packet(1000))).toBe(false);
  });

  test("empty calls publish an omission without creating attachments", async () => {
    const { r, log } = recording();
    await r.finish();
    expect(uploads).toEqual([]);
    expect(log.mock.lastCall?.[0].metadata["audio.recordings"]).toEqual([
      {
        id: "call",
        recording_group_id: "call",
        state: "omitted",
        reason: "no_audio_observed",
      },
    ]);
  });

  test("empty leading intervals are skipped and a late watermark drains without new input", async () => {
    const { r, files } = recording(9600);
    r.record(packet(200));
    r.advance();
    await vi.waitFor(() => expect(uploads).toHaveLength(10));
    expect(files().map(([, , start, duration]) => [start, duration])).toEqual(
      Array.from({ length: 10 }, (_, i) => [200 + i * 100, 100]),
    );
    await r.finish();
  });

  test("holds delay cuts to a safe boundary and close flushes the remainder", async () => {
    const { r, files } = recording(192000);
    r.record(packet(0, 72000));
    const hold = {};
    r.holds.set(hold, 1000);
    r.advance();
    expect(uploads).toHaveLength(0);
    r.holds.set(hold, 2000);
    r.advance();
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await r.finish();
    expect(files()).toEqual([
      ["call-0000", "ready", 0, 2000],
      ["call-0001", "ready", 2000, 1000],
    ]);
  });
});
