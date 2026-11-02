import { expect, test, vi } from "vitest";
import { wrapLiveKit } from "./livekit";
import { livekitChannels } from "../instrumentation/plugins/livekit-interceptors";

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
