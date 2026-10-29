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
