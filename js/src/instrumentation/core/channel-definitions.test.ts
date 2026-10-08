import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { channel, defineInterceptor } from "./channel-definitions";

it("defines sync and async wrapping contracts without tracing configuration", async () => {
  const hooks = defineInterceptor(randomUUID(), {
    sync: channel<[number], number>({ channelName: "sync" }),
    async: channel<[string], Promise<string>, { suffix: string }>({
      channelName: "async",
    }),
  });
  expect(hooks.sync).not.toHaveProperty("tracingChannel");
  expect(hooks.sync).not.toHaveProperty("instrumentationName");
  const remove = hooks.sync.intercept(
    (target, receiver, [n]) => target.call(receiver, n + 1) * 2,
  );
  expect(hooks.sync.invoke((n) => n + 3, undefined, [2], {})).toBe(12);
  remove();
  hooks.async.intercept((target, receiver, [s], additional) =>
    target.call(receiver, s + additional.suffix),
  );
  expect(
    await hooks.async.invoke(async (s) => s.toUpperCase(), undefined, ["a"], {
      suffix: "b",
    }),
  ).toBe("AB");
});
