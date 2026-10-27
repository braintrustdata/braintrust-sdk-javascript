import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { braintrustAISDKTelemetry, wrapAISDK } from "braintrust";
import * as ai from "ai";
import { runOperation } from "../../helpers/provider-runtime.mjs";

export async function runAISDKCodeMode(mode, packageName) {
  const namespace = await import(packageName);
  const codeMode = mode === "auto-hook" ? namespace : wrapAISDK(namespace);
  const run = codeMode.experimental_runCodeMode;
  const root = (name, fn) =>
    runOperation(
      `ai-sdk-code-mode-${mode}-${name}-operation`,
      `code-mode-${mode}-${name}`,
      fn,
    );
  const schema = ai.jsonSchema({
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
    additionalProperties: false,
  });
  const host = {
    inputSchema: schema,
    label: "original receiver",
    async execute({ value }, options) {
      assert.equal(this.label, "original receiver");
      assert.ok(options.toolCallId);
      await delay(20);
      return { value: value * 2 };
    },
  };
  const tools = {
    host,
    unused: {
      inputSchema: schema,
      execute() {
        throw new Error("unused tool executed");
      },
    },
    fail: {
      inputSchema: schema,
      execute() {
        throw new Error("host failure");
      },
    },
    stream: {
      inputSchema: schema,
      async *execute({ value }) {
        yield { value: 0 };
        await delay(10);
        yield { value };
      },
    },
  };
  const originalExecute = host.execute;
  const execute = (js, callId = "outer", extraTools = {}) =>
    run({
      js,
      tools: { ...tools, ...extraTools },
      toolExecutionOptions: { toolCallId: callId, messages: [] },
    });

  await root("sequential", async () => {
    assert.deepEqual(
      await execute(
        "const a = await tools.host({value: 2}); return await tools.host(a);",
      ),
      { value: 8 },
    );
  });
  await root("parallel", async () => {
    let count = 0;
    let release;
    const bothStarted = new Promise((resolve) => {
      release = resolve;
    });
    const parallel = {
      inputSchema: schema,
      async execute({ value }) {
        if (++count === 2) release();
        await bothStarted;
        await delay(20);
        return { value };
      },
    };
    assert.deepEqual(
      await execute(
        "return await Promise.all([tools.parallel({value: 1}), tools.parallel({value: 2})]);",
        "outer",
        { parallel },
      ),
      [{ value: 1 }, { value: 2 }],
    );
  });
  await root("nested", async () => {
    const nested = {
      inputSchema: schema,
      execute({ value }, options) {
        return execute(
          `return await tools.host({value: ${value}});`,
          options.toolCallId,
        );
      },
    };
    assert.deepEqual(
      await execute("return await tools.nested({value: 3});", "outer", {
        nested,
      }),
      { value: 6 },
    );
  });
  await root("host-error", async () => {
    await assert.rejects(execute("return await tools.fail({value: 1});"));
  });
  await root("code-error", async () => {
    await assert.rejects(execute('throw new Error("code failure");'));
  });
  await root("caught-error", async () => {
    assert.equal(
      await execute(
        'try { await tools.fail({value: 1}); } catch { return "recovered"; }',
      ),
      "recovered",
    );
  });
  await root("stream-output", async () => {
    assert.deepEqual(await execute("return await tools.stream({value: 9});"), {
      value: 9,
    });
  });
  await root("concurrent", async () => {
    assert.deepEqual(
      await Promise.all([
        execute("return await tools.host({value: 4});"),
        execute("return await tools.host({value: 5});"),
      ]),
      [{ value: 8 }, { value: 10 }],
    );
  });
  await root("direct", async () => {
    // No call ID or AI SDK generation is required by runCodeMode.
    assert.equal(await run({ js: "return 42;", tools: {} }), 42);
  });
  if (mode !== "wrapped") {
    await root("factory", async () => {
      const tool = namespace.experimental_createCodeModeTool({ host });
      assert.deepEqual(
        await tool.execute(
          { js: "return await tools.host({value: 7});" },
          { toolCallId: "factory", messages: [] },
        ),
        { value: 14 },
      );
    });
  }
  assert.equal(host.execute, originalExecute);

  if (mode !== "wrapped") {
    const { createOpenAI } = await import("ai-sdk-openai-v7-latest");
    const openai = createOpenAI({ baseURL: process.env.OPENAI_BASE_URL });
    if (mode === "combined") ai.registerTelemetry(braintrustAISDKTelemetry());
    await root("generation", async () => {
      const code = namespace.experimental_codeModeTool();
      const result = await ai.generateText({
        model: openai("gpt-4.1-nano"),
        tools: { code, host },
        experimental_toolCallers: { host: ["code", "AI_SDK_DIRECT_TOOL_CALL"] },
        toolChoice: { type: "tool", toolName: "code" },
        prompt:
          "Call code with exactly this JavaScript: return await tools.host({value: 6});",
        maxOutputTokens: 120,
      });
      assert.deepEqual(result.toolResults[0].output, { value: 12 });
      const direct = await ai.generateText({
        model: openai("gpt-4.1-nano"),
        tools: { host },
        toolChoice: { type: "tool", toolName: "host" },
        prompt: "Call host with value 8.",
        maxOutputTokens: 80,
      });
      assert.deepEqual(direct.toolResults[0].output, { value: 16 });
    });
  }
}
