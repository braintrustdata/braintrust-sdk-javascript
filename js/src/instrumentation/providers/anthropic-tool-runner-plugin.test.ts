import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  AnthropicMessage,
  AnthropicToolRunner,
  AnthropicToolRunnerParams,
} from "../../vendor-sdk-types/anthropic";

const { toolSpans, runnerSpan } = vi.hoisted(() => {
  const toolSpans: { args: unknown; log: ReturnType<typeof vi.fn> }[] = [];
  return {
    toolSpans,
    runnerSpan: {
      log: vi.fn(),
      end: vi.fn(),
      traced(
        callback: (span: { log: ReturnType<typeof vi.fn> }) => unknown,
        args: unknown,
      ) {
        const span = { args, log: vi.fn() };
        toolSpans.push(span);
        return callback(span);
      },
    },
  };
});

vi.mock("#braintrust-platform", () => ({
  default: {
    getEnv: vi.fn(),
    newAsyncLocalStorage: vi.fn(() => ({
      getStore: vi.fn(() => undefined),
      run: vi.fn((_store: unknown, callback: () => unknown) => callback()),
    })),
  },
}));

vi.mock("../../logger/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logger/core")>()),
  startSpan: () => runnerSpan,
  withCurrent: (_span: unknown, callback: () => unknown) => callback(),
}));

import { anthropicChannels } from "./anthropic-interceptors";
import { registerAnthropicInstrumentation } from "./anthropic-instrumentation";

registerAnthropicInstrumentation();
afterEach(() => {
  vi.clearAllMocks();
  toolSpans.length = 0;
});

describe("Anthropic tool runner parameter copies", () => {
  it.each(["initial", "replacement", "mutator"] as const)(
    "traces tools from %s parameters without changing caller objects",
    async (mode) => {
      const run = vi.fn(() => "sunny");
      const tool = { name: "get_weather", run };
      const params: AnthropicToolRunnerParams = Object.freeze({
        messages: [],
        tools: [tool],
      });
      Object.freeze(params.tools);
      const message: AnthropicMessage = {
        role: "assistant",
        content: [{ type: "text", text: "sunny" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const factory = (initial: AnthropicToolRunnerParams) => {
        let current = initial;
        return {
          // SDK v1 returns a parameter view instead of its mutable state.
          get params() {
            return { ...current, tools: [...current.tools] };
          },
          setMessagesParams(update) {
            current =
              typeof update === "function" ? update(this.params) : update;
          },
          async *[Symbol.asyncIterator]() {
            await current.tools[0].run?.({ location: "Paris" });
            yield message;
          },
          done: async () => message,
          then: (...args) => Promise.resolve(message).then(...args),
        } satisfies AnthropicToolRunner<AnthropicMessage> & {
          params: AnthropicToolRunnerParams;
        };
      };
      const runner = anthropicChannels.betaMessagesToolRunner.invoke(
        factory,
        undefined,
        [mode === "initial" ? params : { ...params, tools: [] }],
        {},
      );
      const mutate = vi.fn(() => params);
      if (mode !== "initial") {
        runner.setMessagesParams?.(mode === "mutator" ? mutate : params);
      }
      for await (const _ of runner) {
        // Consume the runner so the tool executes and its span completes.
      }

      expect(params.tools[0]).toBe(tool);
      expect(tool.run).toBe(run);
      expect(run).toHaveBeenCalledExactlyOnceWith({ location: "Paris" });
      expect(mutate).toHaveBeenCalledTimes(mode === "mutator" ? 1 : 0);
      expect(toolSpans).toHaveLength(1);
      expect(toolSpans[0].args).toMatchObject({
        name: "tool: get_weather",
        spanAttributes: { type: "tool" },
        event: { input: { location: "Paris" } },
      });
      expect(toolSpans[0].log).toHaveBeenCalledWith({ output: "sunny" });
      expect(runnerSpan.end).toHaveBeenCalledOnce();
    },
  );
});
