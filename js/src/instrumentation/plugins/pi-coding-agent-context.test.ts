import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _exportsForTestingOnly,
  currentSpan,
  startSpan,
  type Span,
} from "../../logger";
import { configureNode } from "../../node/config";
import type {
  PiAgentEvent,
  PiAgentEventListener,
  PiAgentSession,
  PiTool,
} from "../../vendor-sdk-types/pi-coding-agent";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { registry } from "../registry";
import { piCodingAgentChannels } from "./pi-coding-agent-channels";
import { PiCodingAgentPlugin } from "./pi-coding-agent-plugin";

// Use real Braintrust spans and async context, capturing all log writes in memory.
configureNode();
registry.disable();

describe("Pi tool execution context", () => {
  let plugin: PiCodingAgentPlugin;
  let background: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let experiment: ReturnType<typeof _exportsForTestingOnly.initTestExperiment>;

  beforeEach(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    background = _exportsForTestingOnly.useTestBackgroundLogger();
    experiment = _exportsForTestingOnly.initTestExperiment("pi-tool-context");
    plugin = new PiCodingAgentPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  it.each(["streamFn", "streamFunction"] as const)(
    "parents children before and after await to the tool with %s",
    async (property) => {
      let rootSpan: Span;
      let toolSpan: Span;
      const tool: PiTool = {
        name: "lookup",
        execute: async () => {
          toolSpan = currentSpan();
          expect(toolSpan).not.toBe(rootSpan);
          expect(isAutoInstrumentationSuppressed()).toBe(false);
          startSpan({ name: "child-before" }).end();
          await nextTurn();
          expect(currentSpan()).toBe(toolSpan);
          expect(isAutoInstrumentationSuppressed()).toBe(false);
          startSpan({ name: "child-after" }).end();
          return "result";
        },
      };
      const fixture = makeFixture(tool, property);

      await experiment.traced(async (root) => {
        rootSpan = root;
        await fixture.prompt(async () => {
          await fixture.start("call");
          expect(await tool.execute!("call")).toBe("result");
          expect(currentSpan()).toBe(root);
          expect(isAutoInstrumentationSuppressed()).toBe(true);
          await fixture.end("call");
        });
        expect(currentSpan()).toBe(root);
        expect(isAutoInstrumentationSuppressed()).toBe(false);
      });

      const rows = (await background.drain()).flatMap((row) =>
        "span_id" in row ? [row] : [],
      );
      const automaticTool = rows.find(
        (row) => row.span_attributes?.name === "lookup",
      );
      const prompt = rows.find(
        (row) => row.span_attributes?.name === "AgentSession.prompt",
      );
      expect(automaticTool?.span_id).toBe(toolSpan!.spanId);
      expect(automaticTool?.span_parents).toEqual([prompt?.span_id]);
      for (const name of ["child-before", "child-after"]) {
        expect(
          rows.find((row) => row.span_attributes?.name === name)?.span_parents,
        ).toEqual([automaticTool?.span_id]);
      }
      expect(
        rows.filter((row) => row.span_attributes?.name === "lookup"),
      ).toHaveLength(1);
    },
  );

  it.each(["same prompt", "overlapping prompts"] as const)(
    "isolates concurrent tools in %s",
    async (mode) => {
      const gate = deferred();
      const seen = new Map<string, { span: Span; root: Span }>();
      const roots = new Map<string, Span>();
      const tool: PiTool = {
        name: "lookup",
        execute: async (_callId, label) => {
          const key = String(label);
          const span = currentSpan();
          const root = roots.get(key)!;
          expect(span).not.toBe(root);
          seen.set(key, { span, root });
          if (seen.size === 2) gate.resolve();
          await gate.promise;
          await nextTurn();
          expect(currentSpan()).toBe(span);
          startSpan({ name: key }).end();
          return key;
        },
      };
      const fixture = makeFixture(tool);

      if (mode === "same prompt") {
        await experiment.traced(async (root) => {
          roots.set("first", root);
          roots.set("second", root);
          await fixture.prompt(async () => {
            await fixture.start("first");
            await fixture.start("second");
            const first = tool.execute!("first", "first");
            expect(currentSpan()).toBe(root);
            const second = tool.execute!("second", "second");
            expect(currentSpan()).toBe(root);
            expect(await Promise.all([first, second])).toEqual([
              "first",
              "second",
            ]);
            await fixture.end("first");
            await fixture.end("second");
          });
        });
      } else {
        // Reuse the same tool object and ID in two overlapping prompts.
        await Promise.all(
          ["first", "second"].map((label) =>
            experiment.traced(async (root) => {
              roots.set(label, root);
              await fixture.prompt(async () => {
                await fixture.start("shared-id");
                expect(await tool.execute!("shared-id", label)).toBe(label);
                expect(currentSpan()).toBe(root);
                await fixture.end("shared-id");
              });
            }),
          ),
        );
      }

      expect(seen.get("first")!.span).not.toBe(seen.get("second")!.span);
      const rows = (await background.drain()).flatMap((row) =>
        "span_id" in row ? [row] : [],
      );
      for (const label of ["first", "second"]) {
        const observation = seen.get(label)!;
        const child = rows.find((row) => row.span_attributes?.name === label);
        const toolRow = rows.find(
          (row) => row.span_id === observation.span.spanId,
        );
        const prompt = rows.find(
          (row) => row.span_id === toolRow?.span_parents?.[0],
        );
        expect(child?.span_parents).toEqual([observation.span.spanId]);
        expect(prompt?.span_parents).toEqual([observation.root.spanId]);
      }
    },
  );

  it.each(["return", "throw", "resolve", "reject"] as const)(
    "preserves %s behavior, receiver, arguments, and caller context",
    async (mode) => {
      const value = { result: "unchanged" };
      const error = new Error("tool failed");
      const args = { query: "test" };
      const signal = new AbortController().signal;
      const onUpdate = () => {};
      const receiver = { marker: true };
      let rootSpan: Span;
      let returnedPromise: Promise<unknown> | undefined;
      const tool: PiTool = {
        name: "lookup",
        execute: function (...received) {
          expect(this).toBe(receiver);
          expect(received).toEqual(["call", args, signal, onUpdate]);
          expect(currentSpan()).not.toBe(rootSpan);
          expect(isAutoInstrumentationSuppressed()).toBe(false);
          if (mode === "throw") throw error;
          if (mode === "return") return value;
          const span = currentSpan();
          returnedPromise = nextTurn().then(() => {
            expect(currentSpan()).toBe(span);
            if (mode === "reject") throw error;
            return value;
          });
          return returnedPromise;
        },
      };
      const fixture = makeFixture(tool);

      await experiment.traced(async (root) => {
        rootSpan = root;
        await fixture.prompt(async () => {
          await fixture.start("call");
          const invoke = () =>
            tool.execute!.call(receiver, "call", args, signal, onUpdate);
          if (mode === "throw") {
            expect(invoke).toThrow(error);
          } else {
            const result = invoke();
            if (mode === "return") expect(result).toBe(value);
            else {
              expect(result).toBe(returnedPromise);
              if (mode === "reject") await expect(result).rejects.toBe(error);
              else await expect(result).resolves.toBe(value);
            }
          }
          expect(currentSpan()).toBe(root);
          expect(isAutoInstrumentationSuppressed()).toBe(true);
          await fixture.end("call", mode === "throw" || mode === "reject");
        });
      });
    },
  );

  it.each([
    "unknown ID",
    "missing ID",
    "non-string ID",
    "ended tool",
    "outside prompt",
    "finalized prompt",
  ] as const)("preserves the caller context with %s", async (mode) => {
    let expectedSpan: Span;
    const tool: PiTool = {
      name: "lookup",
      execute: async () => {
        expect(currentSpan()).toBe(expectedSpan);
        expect(isAutoInstrumentationSuppressed()).toBe(false);
        await nextTurn();
        expect(currentSpan()).toBe(expectedSpan);
        return "unbound";
      },
    };
    const fixture = makeFixture(tool);
    await experiment.traced(async (root) => {
      expectedSpan = root;
      if (mode === "outside prompt") {
        await fixture.prompt(async () => {});
        expect(await tool.execute!("call")).toBe("unbound");
        return;
      }

      await fixture.prompt(async () => {
        await fixture.start("call");
        if (mode === "ended tool") await fixture.end("call");
        if (mode === "finalized prompt") plugin.disable();
        const id =
          mode === "missing ID"
            ? undefined
            : mode === "non-string ID"
              ? 42
              : mode === "unknown ID"
                ? "other"
                : "call";
        expect(await tool.execute!(id)).toBe("unbound");
        expect(currentSpan()).toBe(root);
      });
    });
  });
});

function makeFixture(
  tool: PiTool,
  property: "streamFn" | "streamFunction" = "streamFunction",
) {
  const listeners = new Set<PiAgentEventListener>();
  const agent = {
    state: { tools: [tool] },
    [property]: () => {
      throw new Error("This context test must not call a model");
    },
    subscribe(listener: PiAgentEventListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const session: PiAgentSession = { agent, prompt: async () => {} };
  const emit = async (event: PiAgentEvent) => {
    for (const listener of listeners)
      await listener(event, new AbortController().signal);
  };
  return {
    prompt: (callback: () => Promise<void>) =>
      piCodingAgentChannels.prompt.invoke(
        callback,
        session,
        ["test", undefined],
        { session },
      ),
    start: (toolCallId: string) =>
      emit({
        type: "tool_execution_start",
        toolCallId,
        toolName: tool.name,
        args: {},
      }),
    end: (toolCallId: string, isError = false) =>
      emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: tool.name,
        result: "result",
        isError,
      }),
  };
}

function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
