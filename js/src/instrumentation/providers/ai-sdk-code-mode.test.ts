import { registerInstrumentation } from "../registrations/aisdk";
import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeAll, beforeEach, expect, it } from "vite-plus/test";
import { _exportsForTestingOnly } from "../../logger/testing";
import {
  NOOP_SPAN,
  currentSpan,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger/core";
import { braintrustAISDKTelemetry } from "../../wrappers/ai-sdk/telemetry";
import { configureNode } from "../../node/config";
import { aiSDKChannels } from "./ai-sdk-interceptors";
import { traceAISDKCodeMode } from "./ai-sdk-code-mode";
import {
  AI_SDK_TOOL_CALL_ID,
  AI_SDK_TOOL_CAPTURE,
  currentAISDKToolSpan,
  traceAISDKTool,
} from "./ai-sdk-tool-tracing";
import { runWithAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";

configureNode();
let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
beforeAll(async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  registerInstrumentation();
});
beforeEach(() => {
  logger = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({ projectName: "code-mode-test", projectId: "test-project-id" });
});
afterEach(() => {
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

it("binds host callbacks across lost context and isolates concurrent runs with identical call IDs", async () => {
  const worker = new AsyncResource("worker-before-execution");
  const parent = startSpan({ name: "parent" });
  const tools = {
    host: {
      label: "receiver",
      needsApproval() {
        expect(this).toBe(tools.host);
        return false;
      },
      execute: function (input: unknown) {
        expect(this.label).toBe("receiver");
        expect(currentSpan().spanId).not.toBe(parent.spanId);
        return input;
      },
    },
  };
  const original = tools.host.execute;
  await withCurrent(parent, () =>
    Promise.all(
      [1, 2].map((value) =>
        traceAISDKCodeMode(
          async (params) => {
            const options = { toolCallId: "outer:tool-0" };
            expect(params.tools.host.needsApproval).toBeTypeOf("function");
            Reflect.apply(
              params.tools.host.needsApproval as Function,
              params.tools.host,
              [value, options],
            );
            return worker.runInAsyncScope(() =>
              params.tools.host.execute!(value, options),
            );
          },
          {
            js: String(value),
            tools,
            toolExecutionOptions: { toolCallId: "outer" },
          },
        ),
      ),
    ),
  );
  expect(tools.host.execute).toBe(original);
  parent.end();
  const spans = (await logger.drain()) as Record<string, any>[];
  const outer = spans.filter((s) => s.span_attributes?.name === "codeMode");
  const hosts = spans.filter((s) => s.span_attributes?.name === "host");
  expect(outer).toHaveLength(2);
  expect(hosts).toHaveLength(2);
  for (const span of outer) {
    expect(span.span_attributes.type).toBe("tool");
    expect(span.span_parents).toEqual([parent.spanId]);
    expect(hosts.find((s) => s.input === Number(span.input.js))).toMatchObject({
      span_attributes: { type: "function" },
      span_parents: [span.span_id],
    });
  }
  worker.emitDestroy();
});

it("reuses the executing tool span and deduplicates manual plus automatic run hooks", async () => {
  const result = traceAISDKTool(
    () =>
      traceAISDKCodeMode(
        (params) =>
          traceAISDKCodeMode(
            async (inner) =>
              inner.tools.host.execute!("input", {
                toolCallId: "outer:tool-0",
              }),
            params,
          ),
        {
          js: "source",
          tools: {
            host: {
              execute: (input) =>
                traceAISDKTool(() => input, {
                  name: "host",
                  input,
                  toolCallId: "outer:tool-0",
                }),
            },
          },
          toolExecutionOptions: { toolCallId: "outer" },
        },
      ),
    { name: "customCodeTool", input: { js: "source" }, toolCallId: "outer" },
  );
  expect(await result).toBe("input");
  const spans = (await logger.drain()) as Record<string, any>[];
  expect(spans).toHaveLength(2);
  const parent = spans.find(
    (s) => s.span_attributes?.name === "customCodeTool",
  );
  expect(parent!.span_attributes.type).toBe("tool");
  expect(spans.find((s) => s.span_attributes?.name === "host")).toMatchObject({
    span_attributes: { type: "function" },
    span_parents: [parent!.span_id],
    output: "input",
  });
});

it.each([false, true])(
  "preserves synchronous and asynchronous errors (%s)",
  async (asyncError) => {
    const error = new Error("host failure");
    const run = () =>
      traceAISDKCodeMode(
        (params) =>
          params.tools.host.execute!({}, { toolCallId: "outer:tool-0" }),
        {
          js: "source",
          tools: {
            host: {
              execute() {
                if (asyncError) return Promise.reject(error);
                throw error;
              },
            },
          },
        },
      );
    if (asyncError) await expect(run()).rejects.toBe(error);
    else expect(run).toThrow(error);
    const spans = (await logger.drain()) as Record<string, any>[];
    expect(spans).toHaveLength(2);
    for (const span of spans) expect(span.error).toContain("host failure");
  },
);

it("preserves promises, iterator output and context, and suppression", async () => {
  const promise = Promise.resolve("value");
  expect(traceAISDKTool(() => promise, { name: "promise", input: 1 })).toBe(
    promise,
  );
  const iterator = traceAISDKTool(
    () =>
      (async function* () {
        expect(currentSpan().spanId).toBeTruthy();
        yield "first";
        yield "last";
      })(),
    { name: "stream", input: 2 },
  );
  const chunks = [];
  for await (const chunk of iterator) chunks.push(chunk);
  expect(chunks).toEqual(["first", "last"]);
  await runWithAutoInstrumentationSuppressed(() =>
    traceAISDKCodeMode(async () => 3, { js: "", tools: {} }),
  );
  const spans = (await logger.drain()) as Record<string, any>[];
  expect(spans).toHaveLength(2);
  expect(spans.find((s) => s.span_attributes?.name === "stream")!.output).toBe(
    "last",
  );
});

it("reuses telemetry ownership and propagates capture flags to host tools", async () => {
  const telemetry = braintrustAISDKTelemetry();
  const event = {
    callId: "generation",
    recordInputs: false,
    recordOutputs: false,
  };
  const toolCall = {
    toolCallId: "outer",
    toolName: "code",
    input: { js: "private source" },
  };
  telemetry.onStart({ ...event, operationId: "ai.generateText" });
  telemetry.onToolExecutionStart({ ...event, toolCall });
  await telemetry.executeTool({
    toolCallId: "outer",
    execute: () =>
      traceAISDKCodeMode(
        async (input) =>
          input.tools.host.execute!("private input", {
            toolCallId: "outer:tool-0",
          }),
        {
          js: "private source",
          tools: { host: { execute: () => "private output" } },
          toolExecutionOptions: { toolCallId: "outer" },
        },
      ),
  });
  telemetry.onToolExecutionEnd({
    ...event,
    toolCall,
    toolOutput: { type: "tool-result", output: "private output" },
  });
  telemetry.onEnd({ ...event, operationId: "ai.generateText" });
  const spans = (await logger.drain()) as Record<string, any>[];
  expect(spans).toHaveLength(3);
  for (const span of spans) {
    expect(span).not.toHaveProperty("input");
    expect(span).not.toHaveProperty("output");
  }
  const code = spans.find((s) => s.span_attributes?.name === "code");
  expect(code!.span_attributes.type).toBe("tool");
  expect(spans.find((s) => s.span_attributes?.name === "host")).toMatchObject({
    span_attributes: { type: "function" },
    span_parents: [code!.span_id],
  });
});

it.each([false, true])(
  "deduplicates legacy AI SDK tool wrapping and catches sync errors (%s)",
  async (fail) => {
    const error = new Error("host failed synchronously");
    const host = {
      execute: () => {
        if (fail) throw error;
        return 7;
      },
    };
    const params = {
      tools: {
        host,
        code: {
          execute: () =>
            traceAISDKCodeMode(
              async (input) =>
                input.tools.host.execute!({}, { toolCallId: "code:tool-0" }),
              {
                js: "source",
                tools: { host },
                toolExecutionOptions: { toolCallId: "code" },
              },
            ),
        },
      },
    };
    await aiSDKChannels.generateText.invoke(
      async () => {
        const run = () =>
          Reflect.apply(params.tools.code.execute, params.tools.code, [
            { js: "source" },
            { toolCallId: "code" },
          ]);
        if (fail) await expect(run()).rejects.toBe(error);
        else expect(await run()).toBe(7);
        return { text: "done" };
      },
      undefined,
      [params],
      {},
    );
    const spans = (await logger.drain()) as Record<string, any>[];
    expect(spans).toHaveLength(3);
    const code = spans.find((s) => s.span_attributes?.name === "code")!;
    const child = spans.find((s) => s.span_attributes?.name === "host")!;
    expect(code.span_attributes.type).toBe("tool");
    expect(child.span_attributes.type).toBe("function");
    expect(child.span_parents).toEqual([code.span_id]);
    if (fail) {
      expect(child.error).toContain("host failed synchronously");
      expect(code.error).toContain("host failed synchronously");
    } else expect(child.output).toBe(7);
  },
);

it("does not treat a no-op span from before initialization as a tool owner", async () => {
  Object.defineProperty(NOOP_SPAN, AI_SDK_TOOL_CALL_ID, {
    value: "outer",
    configurable: true,
  });
  Object.defineProperty(NOOP_SPAN, AI_SDK_TOOL_CAPTURE, {
    value: { recordInputs: false, recordOutputs: false },
    configurable: true,
  });
  try {
    expect(
      withCurrent(NOOP_SPAN, () => currentAISDKToolSpan("outer")),
    ).toBeUndefined();
    withCurrent(NOOP_SPAN, () =>
      traceAISDKTool(() => "output", {
        name: "tool",
        input: "input",
        toolCallId: "outer",
      }),
    );
    expect(await logger.drain()).toEqual([
      expect.objectContaining({ input: "input", output: "output" }),
    ]);
  } finally {
    Reflect.deleteProperty(NOOP_SPAN, AI_SDK_TOOL_CAPTURE);
    Reflect.deleteProperty(NOOP_SPAN, AI_SDK_TOOL_CALL_ID);
  }
});
