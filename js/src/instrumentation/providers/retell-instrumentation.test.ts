import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { _exportsForTestingOnly } from "../../logger/testing";
import { currentSpan, initLogger, traced } from "../../logger/core";
import { configureNode } from "../../node/config";
import { wrapRetell } from "../../wrappers/retell";
import { retellChannels } from "./retell-interceptors";

configureNode();

describe("Retell execution instrumentation", () => {
  let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({ projectName: "tmp-retell", projectId: "test-project-id" });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it.each([
    ["call", "createPhoneCall"],
    ["call", "createWebCall"],
    ["call", "retrieve"],
    ["chat", "create"],
    ["chat", "createChatCompletion"],
  ] as const)(
    "preserves %s.%s calls, promises and errors",
    async (resource, method) => {
      const request = { agent_id: "agent", chat_id: "chat", content: "Hello" };
      const options = { headers: { Authorization: "sentinel-auth-secret" } };
      const output = {
        call_id: "call",
        messages: [{ role: "agent", content: "Hi" }],
      };
      const promise = Object.assign(Promise.resolve(output), {
        asResponse: () => "helper",
      });
      const error = new Error("provider failure");
      let mode = "success";
      const target = {
        [method]: vi.fn(function (
          this: unknown,
          input: unknown,
          opts?: unknown,
        ) {
          expect(this).toBe(target);
          expect(input).toBe(request);
          expect(opts).toBe(options);
          expect(currentSpan().id).toBeTruthy();
          if (mode === "throw") throw error;
          if (mode === "reject") return Promise.reject(error);
          return promise;
        }),
      };
      const raw = {
        call: {},
        chat: {},
        agent: { untouched: true },
        [resource]: target,
      };
      const wrapped = wrapRetell(raw);
      expect(wrapRetell(raw)).toBe(wrapped);
      expect(wrapRetell(wrapped)).toBe(wrapped);
      expect(wrapped.agent).toBe(raw.agent);
      const invoke = () =>
        (wrapped[resource] as typeof target)[method](request, options);
      expect(invoke()).toBe(promise);
      expect(promise.asResponse()).toBe("helper");
      expect(await promise).toBe(output);
      mode = "throw";
      expect(invoke).toThrow(error);
      mode = "reject";
      await expect(invoke()).rejects.toBe(error);
      expect(target[method]).toHaveBeenCalledTimes(3);
      const rows = await logger.drain();
      expect(rows).toHaveLength(3);
      expect(JSON.stringify(rows)).not.toContain("sentinel-auth-secret");
      for (const row of rows)
        expect(row).toMatchObject({ metrics: { end: expect.any(Number) } });
    },
  );

  it("omits web-call credentials without changing the response", async () => {
    const response = Object.freeze({
      call_id: "call",
      agent_id: "agent",
      access_token: "sentinel-access-token",
      ice_servers: [{ credential: "sentinel-ice-password" }],
      metadata: { api_key: "sentinel-metadata-secret" },
    });
    const raw = {
      call: { createWebCall: async (_: unknown) => response },
      chat: {},
    };
    const wrapped = wrapRetell(raw);
    expect(
      await wrapped.call.createWebCall({
        agent_id: "agent",
        api_key: "sentinel-request-secret",
      }),
    ).toBe(response);
    const rows = await logger.drain();
    expect(rows).toMatchObject([
      {
        input: { agent_id: "agent" },
        output: { call_id: "call", agent_id: "agent" },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("sentinel-");
    expect(response.access_token).toBe("sentinel-access-token");
  });

  it("captures completed-call transcript text without recording URLs or phone numbers", async () => {
    const response = {
      call_id: "call",
      call_status: "ended",
      transcript_object: [
        { role: "agent", content: "Hello", words: [{ word: "Hello" }] },
      ],
      recording_url: "sentinel-signed-recording-url",
      to_number: "sentinel-phone-number",
    };
    const wrapped = wrapRetell({
      call: { retrieve: async (_: string) => response },
      chat: {},
    });
    await wrapped.call.retrieve("call");
    const rows = await logger.drain();
    expect(rows).toMatchObject([
      {
        input: { call_id: "call" },
        output: {
          call_id: "call",
          call_status: "ended",
          messages: [{ role: "assistant", content: "Hello" }],
        },
        span_attributes: { name: "retell.call.retrieve", type: "task" },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("sentinel-");
  });

  it("parents API spans to the current trace and avoids manual/auto duplication", async () => {
    const response = { call_id: "call" };
    const raw = {
      call: {
        createWebCall(request: unknown) {
          return retellChannels.createWebCall.invoke(
            async () => response,
            this,
            [request],
            {},
          );
        },
      },
      chat: {},
    };
    await traced(
      async () => wrapRetell(raw).call.createWebCall({ agent_id: "agent" }),
      { name: "parent" },
    );
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows).toHaveLength(2);
    const parent = rows.find((row) => row.span_attributes?.name === "parent");
    const child = rows.find(
      (row) => row.span_attributes?.name === "retell.call.createWebCall",
    );
    expect(child).toMatchObject({ span_parents: [parent?.span_id] });
  });

  it("retains resource receivers for uninstrumented methods", () => {
    class Calls {
      #value = "private";
      untouched() {
        return this.#value;
      }
    }
    const raw = { call: new Calls(), chat: {} };
    expect(wrapRetell(raw).call.untouched()).toBe("private");
  });

  it.each(["await", "withResponse", "asResponse"])(
    "preserves lazy SDK response parsing for %s consumers",
    async (mode) => {
      const response = new Response(
        JSON.stringify({ call_id: "call", access_token: "sentinel-token" }),
        { headers: { "content-type": "application/json" } },
      );
      let parsed: Promise<unknown> | undefined;
      const parse = () => (parsed ??= response.json());
      const promise = {
        then: Promise.resolve<unknown>(undefined).then,
        asResponse: () => Promise.resolve(response),
        withResponse: async () => ({ data: await parse(), response }),
      };
      for (const key of ["then", "catch", "finally"] as const) {
        Object.defineProperty(promise, key, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) =>
            Reflect.apply(parse()[key], parse(), args),
        });
      }
      const client = wrapRetell({
        call: { createWebCall: () => promise },
        chat: {},
      });
      const result = client.call.createWebCall();
      expect(result).toBe(promise);
      if (mode === "asResponse") {
        const raw = await result.asResponse();
        expect(raw.bodyUsed).toBe(false);
        expect(await raw.json()).toEqual({
          call_id: "call",
          access_token: "sentinel-token",
        });
      } else if (mode === "withResponse") {
        expect((await result.withResponse()).data).toEqual({
          call_id: "call",
          access_token: "sentinel-token",
        });
      } else {
        expect(await result).toEqual({
          call_id: "call",
          access_token: "sentinel-token",
        });
      }
      const rows = await logger.drain();
      expect(rows).toMatchObject([
        { output: { call_id: "call" }, metrics: { end: expect.any(Number) } },
      ]);
      expect(JSON.stringify(rows)).not.toContain("sentinel-token");
    },
  );
});
