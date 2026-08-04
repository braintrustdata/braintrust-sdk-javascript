import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import { channel, defineChannels } from "./channel-definitions";

describe("typed channel invocation hooks", () => {
  it("does not dispatch tracing subscribers from invoke", async () => {
    const channels = defineChannels(
      `typed-channel-async-${randomUUID()}`,
      {
        call: channel<[number], number, { label?: string }>({
          channelName: "call",
          kind: "async",
        }),
      },
      { instrumentationName: INSTRUMENTATION_NAMES.BRAINTRUST_JS_LOGGER },
    );
    const lifecycle: string[] = [];
    const tracingChannel = channels.call.tracingChannel();
    const handlers = {
      start: (event: { arguments: number[] }) =>
        lifecycle.push(`start:${event.arguments[0]}`),
      asyncEnd: (event: { result?: number }) =>
        lifecycle.push(`asyncEnd:${event.result}`),
    };
    tracingChannel.subscribe(handlers);
    const removeInterceptor = channels.call.intercept(
      async (target, _thisArg, args, additional) => {
        lifecycle.push(`intercept:${additional.label}`);
        return (await target.apply({ offset: 4 }, [args[0] + 1])) * 2;
      },
    );
    const target = vi.fn(async function (
      this: { offset: number },
      value: number,
    ) {
      lifecycle.push("target");
      return this.offset + value;
    });

    await expect(
      channels.call.invoke(target, { offset: 0 }, [2], { label: "test" }),
    ).resolves.toBe(14);
    expect(tracingChannel.hasSubscribers).toBe(true);
    expect(lifecycle).toEqual(["intercept:test", "target"]);

    removeInterceptor();
    tracingChannel.unsubscribe(handlers);
  });

  it("supports receiver, argument, and output patching for sync channels", () => {
    const channels = defineChannels(
      `typed-channel-sync-${randomUUID()}`,
      {
        call: channel<[string], string>({
          channelName: "call",
          kind: "sync-stream",
        }),
      },
      { instrumentationName: INSTRUMENTATION_NAMES.BRAINTRUST_JS_LOGGER },
    );
    channels.call.intercept((target, _thisArg, args) =>
      target.apply({ prefix: "patched" }, [args[0].toUpperCase()]),
    );

    expect(
      channels.call.invoke(
        function (this: { prefix: string }, value: string) {
          return `${this.prefix}:${value}`;
        },
        { prefix: "original" },
        ["value"],
        {},
      ),
    ).toBe("patched:VALUE");
  });
});
