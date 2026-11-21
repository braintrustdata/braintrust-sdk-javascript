import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { _exportsForTestingOnly } from "../../logger/testing";
import { currentSpan, initLogger } from "../../logger/core";
import { configureNode } from "../../node/config";
import { wrapAgentKitTool } from "../../wrappers/agent-kit-tools";
import { registerInstrumentation } from "../registrations/agentKit";
import { agentKitChannels } from "./agent-kit-interceptors";

configureNode();
registerInstrumentation();

describe("AgentKit execution instrumentation", () => {
  let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    logger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({ projectName: "tmp-agent-kit", projectId: "test-project-id" });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("parents model and tool calls under the agent within a network", async () => {
    const messages = [{ type: "text", role: "assistant", content: "Done" }];
    const modelResult = {
      output: messages,
      raw: {
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        authKey: "sentinel-model-secret",
      },
    };
    const agent = { name: "worker" };
    const network = { name: "team", state: { results: [] as unknown[] } };
    const toolDefinition = {
      name: "lookup",
      handler: (_input: unknown) => "found",
    };
    const tool = agentKitChannels.createTool.invoke(
      () => toolDefinition,
      undefined,
      [{}],
      {},
    ) as typeof toolDefinition;
    await agentKitChannels.networkRun.invoke(
      async () => {
        await agentKitChannels.route.invoke(
          async () => [agent],
          network,
          ["question"],
          {},
        );
        const result = await agentKitChannels.agentRun.invoke(
          async () => {
            await agentKitChannels.infer.invoke(
              async () => modelResult,
              {},
              ["worker", [{ role: "user", content: "question" }], [], "auto"],
              {},
            );
            expect(tool.handler({ query: "question" })).toBe("found");
            return { output: messages, agent };
          },
          agent,
          ["question"],
          {},
        );
        network.state.results.push(result);
        return network;
      },
      network,
      ["question"],
      {},
    );
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows).toHaveLength(5);
    const byName = (name: string) =>
      rows.find((row) => row.span_attributes?.name === name)!;
    const root = byName("agentkit.network.run");
    const agentSpan = byName("agentkit.agent.run");
    expect(agentSpan.span_parents).toEqual([root.span_id]);
    expect(byName("agentkit.network.route")).toMatchObject({
      output: ["worker"],
      span_parents: [root.span_id],
    });
    for (const name of ["agentkit.model.infer", "agentkit.tool"]) {
      expect(byName(name).span_parents).toEqual([agentSpan.span_id]);
    }
    expect(byName("agentkit.model.infer")).toMatchObject({
      output: messages,
      metrics: { prompt_tokens: 4, completion_tokens: 2, tokens: 6 },
    });
    expect(root.output).toEqual(messages);
    expect(JSON.stringify(rows)).not.toContain("sentinel-model-secret");
  });

  it.each(["agentRun", "networkRun", "infer", "route"] as const)(
    "preserves %s promise helpers and receiver",
    async (key) => {
      const hook = agentKitChannels[key];
      const self = { name: "instance" };
      const output = { output: [] };
      const promise = Object.assign(Promise.resolve(output), {
        helper: () => "helper",
      });
      const target = function (this: unknown, ..._args: unknown[]) {
        expect(this).toBe(self);
        expect(currentSpan().id).toBeTruthy();
        return promise;
      };
      const args =
        key === "infer"
          ? (["agent", [], [], "auto"] as const)
          : (["input"] as const);
      // Each channel receives the actual SDK method's argument tuple.
      const result =
        key === "infer"
          ? agentKitChannels.infer.invoke(
              target,
              self,
              [...args] as [string, unknown, unknown, unknown],
              {},
            )
          : (hook as typeof agentKitChannels.agentRun).invoke(
              target,
              self,
              ["input"],
              {},
            );
      expect(result).toBe(promise);
      expect(result.helper()).toBe("helper");
      expect(await result).toBe(output);
      const rows = await logger.drain();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ metrics: { end: expect.any(Number) } });
    },
  );

  it.each(["throw", "reject"])(
    "records %s errors without replacing them",
    async (mode) => {
      const error = new Error("original error");
      const invoke = () =>
        agentKitChannels.agentRun.invoke(
          () => {
            if (mode === "throw") throw error;
            return Promise.reject(error);
          },
          { name: "agent" },
          ["input"],
          {},
        );
      if (mode === "throw") expect(invoke).toThrow(error);
      else await expect(invoke()).rejects.toBe(error);
      expect(await logger.drain()).toMatchObject([
        {
          error: expect.stringContaining("original error"),
          metrics: { end: expect.any(Number) },
        },
      ]);
    },
  );

  it("wraps synchronous and asynchronous tools once and preserves context", async () => {
    const context = { agent: { name: "agent" } };
    const input = { query: "question" };
    const promise = Promise.resolve("async result");
    const definition = {
      name: "lookup",
      handler(this: unknown, value: unknown, options?: unknown) {
        expect(this).toBe(definition);
        expect(value).toBe(input);
        expect(options).toBe(context);
        return promise;
      },
    };
    const wrapped = wrapAgentKitTool(definition);
    expect(wrapAgentKitTool(wrapped)).toBe(wrapped);
    expect(wrapAgentKitTool(definition)).toBe(wrapped);
    expect(wrapped.handler(input, context)).toBe(promise);
    await promise;
    const sync = wrapAgentKitTool({
      name: "sync",
      handler: () => "sync result",
    });
    expect(sync.handler()).toBe("sync result");
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.output).sort()).toEqual([
      "async result",
      "sync result",
    ]);
  });

  it("retains tool error identity for synchronous throws and rejected promises", async () => {
    const error = new Error("tool failed");
    const sync = wrapAgentKitTool({
      handler() {
        throw error;
      },
    });
    expect(() => sync.handler()).toThrow(error);
    const asyncTool = wrapAgentKitTool({
      handler: () => Promise.reject(error),
    });
    await expect(asyncTool.handler()).rejects.toBe(error);
    expect(await logger.drain()).toHaveLength(2);
  });

  it("does not invent token metrics for unsupported or invalid usage", async () => {
    await agentKitChannels.infer.invoke(
      async () => ({
        output: [],
        raw: {
          usage: {
            prompt_tokens: NaN,
            completion_tokens: -1,
            total_tokens: "6",
          },
        },
      }),
      {},
      ["agent", [], [], "auto"],
      {},
    );
    const rows = (await logger.drain()) as Record<string, any>[];
    expect(rows[0].metrics).not.toHaveProperty("prompt_tokens");
    expect(rows[0].metrics).not.toHaveProperty("completion_tokens");
    expect(rows[0].metrics).not.toHaveProperty("tokens");
  });

  it("keeps tools usable when frozen after creation or supplied already frozen", () => {
    const tool = agentKitChannels.createTool.invoke(
      () => ({ name: "tool", handler: () => "ok" }),
      undefined,
      [{}],
      {},
    );
    const frozen = Object.freeze(tool as { handler(): string });
    expect(frozen.handler()).toBe("ok");
    const immutable = Object.freeze({ handler: () => "unchanged" });
    expect(wrapAgentKitTool(immutable)).toBe(immutable);
    expect(immutable.handler()).toBe("unchanged");
  });

  it("prepares plain and SDK-populated tools before invocation without replacing tool objects", async () => {
    const error = new Error("plain tool failed");
    const tool = { name: "plain", handler: () => Promise.reject(error) };
    const agent = { tools: new Map([["plain", tool]]) };
    await agentKitChannels.prepareTools.invoke(
      async () => {
        expect(agent.tools.get("plain")).toBe(tool);
        await expect(tool.handler()).rejects.toBe(error);
      },
      agent,
      [[], undefined, undefined, undefined],
      {},
    );
    expect(await logger.drain()).toMatchObject([
      {
        error: expect.stringContaining("plain tool failed"),
        metadata: { tool_name: "plain" },
      },
    ]);
  });

  it("preserves tool call receivers, extra arguments and stable handler identity", () => {
    const receiver = { marker: "receiver" };
    const tool = {
      handler(this: unknown, ...args: unknown[]) {
        expect(this).toBe(receiver);
        return args;
      },
    };
    const wrapped = wrapAgentKitTool(tool);
    const handler = wrapped.handler;
    expect(wrapAgentKitTool(tool).handler).toBe(handler);
    expect(handler.call(receiver, 1, 2, 3)).toEqual([1, 2, 3]);
  });

  it("does not let a throwing tool name getter prevent execution", () => {
    const tool = {
      get name(): string {
        throw new Error("unreadable metadata");
      },
      handler: () => "ok",
    };
    expect(wrapAgentKitTool(tool).handler()).toBe("ok");
  });
});
