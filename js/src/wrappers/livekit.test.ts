import { expect, test, vi } from "vite-plus/test";
import { wrapLiveKit } from "./livekit";
import { livekitChannels } from "../instrumentation/providers/livekit-interceptors";

test("wraps ESM namespaces and preserves return identity when wrapped twice", () => {
  const result = Promise.resolve();
  class AgentSession {
    _startImpl() {
      return result;
    }
  }
  // Real ESM namespace objects have a null prototype.
  const module = Object.assign(Object.create(null), {
    voice: Object.assign(Object.create(null), { AgentSession }),
    telemetry: Object.assign(Object.create(null), { tracer: {} }),
  });
  const observed = vi.fn();
  const remove = livekitChannels.start.intercept((target, receiver, args) => {
    observed(receiver);
    return Reflect.apply(target, receiver, args);
  });
  try {
    const wrapped = wrapLiveKit(wrapLiveKit(module));
    const session = new wrapped.voice.AgentSession();
    expect(session).toBeInstanceOf(AgentSession);
    expect(session._startImpl()).toBe(result);
    expect(observed).toHaveBeenCalledExactlyOnceWith(session);
  } finally {
    remove();
  }
});

test("new sessions hand LiveKit's job context lookup to the job context hook", () => {
  class AgentSession {}
  const job = { _redactionEnabled: true };
  const getJobContext = vi.fn(() => job);
  const module = {
    voice: { AgentSession },
    telemetry: { tracer: {} },
    getJobContext,
  };
  const seen: unknown[] = [];
  const remove = livekitChannels.jobContext.intercept(
    (target, receiver, args) => {
      seen.push(Reflect.apply(target, receiver, args));
      return Reflect.apply(target, receiver, args);
    },
  );
  try {
    new (wrapLiveKit(module).voice.AgentSession)();
    // LiveKit's own redaction looks the context up without requiring one.
    expect(getJobContext).toHaveBeenCalledWith(false);
    expect(seen).toEqual([job]);
  } finally {
    remove();
  }
});

test("manual sessions route all model services through shared hooks exactly once", async () => {
  const output = Promise.resolve("result");
  class AgentSession {
    activity = {
      agentSession: this,
      llm: { chat: vi.fn(() => output) },
      stt: { recognize: vi.fn(() => output), stream: vi.fn(() => output) },
      tts: { synthesize: vi.fn(() => output), stream: vi.fn(() => output) },
      async _startSessionImpl() {},
    };
    emit() {
      return true;
    }
  }
  const module = { voice: { AgentSession }, telemetry: { tracer: {} } };
  const session = new (wrapLiveKit(module).voice.AgentSession)();
  session.emit();
  await session.activity._startSessionImpl();
  session.emit();
  await session.activity._startSessionImpl();
  const calls: unknown[] = [];
  const remove = livekitChannels.model.intercept(
    (target, receiver, args, additional) => {
      calls.push({
        receiver,
        args,
        kind: additional.kind,
        method: additional.method,
      });
      return Reflect.apply(target, receiver, args);
    },
  );
  try {
    expect(session.activity.llm.chat()).toBe(output);
    expect(session.activity.stt.recognize()).toBe(output);
    expect(session.activity.stt.stream()).toBe(output);
    expect(session.activity.tts.synthesize()).toBe(output);
    expect(session.activity.tts.stream()).toBe(output);
    expect(calls).toEqual([
      { receiver: session.activity.llm, args: [], kind: "llm", method: "chat" },
      {
        receiver: session.activity.stt,
        args: [],
        kind: "stt",
        method: "recognize",
      },
      {
        receiver: session.activity.stt,
        args: [],
        kind: "stt",
        method: "stream",
      },
      {
        receiver: session.activity.tts,
        args: [],
        kind: "tts",
        method: "synthesize",
      },
      {
        receiver: session.activity.tts,
        args: [],
        kind: "tts",
        method: "stream",
      },
    ]);
  } finally {
    remove();
  }
});
