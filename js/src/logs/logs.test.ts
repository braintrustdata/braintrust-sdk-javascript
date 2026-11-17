import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { inspect } from "node:util";
import { Console } from "node:console";
import { Writable } from "node:stream";
import {
  BraintrustState,
  Logger,
  TestBackgroundLogger,
  _internalGetGlobalState,
} from "../logger/core";
import { LazyValue } from "../util";
import { wrapConsole } from "./index";
import { consoleMethods } from "./console";
import { configureNode } from "../node/config";
import iso from "#braintrust-platform";
import type { ExperimentEvent } from "../util";
import { debugLogger } from "../debug-logger";
import { logError } from "../framework";
import { SimpleProgressReporter } from "../reporters/progress";

configureNode();

async function drain(
  background: TestBackgroundLogger,
): Promise<ExperimentEvent[]> {
  return (await background.drain()) as ExperimentEvent[];
}

function setup() {
  const state = new BraintrustState({});
  const background = new TestBackgroundLogger();
  vi.spyOn(state, "bgLogger").mockReturnValue(background);
  const enqueue = vi.spyOn(background, "log");
  const logger = new Logger(
    state,
    new LazyValue(async () => ({
      org_id: "org",
      project: { id: "project", name: "application-logs", fullInfo: {} },
    })),
    {},
  );
  return { state, background, logger, enqueue };
}

function fakeConsole() {
  return {
    log: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function mockGlobalConsole() {
  const target = { ...console, ...fakeConsole() };
  vi.stubGlobal("console", target);
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("application logs", () => {
  test("uploads each SDK and console log once with no follow-up merge", async () => {
    const rows: ExperimentEvent[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/logs3")) {
        rows.push(...JSON.parse(String(init?.body)).rows);
      }
      return Response.json({});
    });
    const state = new BraintrustState({ fetch, noExitFlush: true });
    state.apiUrl = "https://api.test";
    state.orgId = "org";
    state.httpLogger().syncFlush = true;
    const logger = new Logger(
      state,
      new LazyValue(async () => ({
        org_id: "org",
        project: { id: "project", name: "test", fullInfo: {} },
      })),
      {},
    );
    const target = fakeConsole();
    const originals = { ...target };
    const uninstrument = wrapConsole(target, { logger });
    const id = logger.info(logger.fmt`User ${"Ada"}`);
    await logger.flush();
    for (const method of consoleMethods) {
      target[method](`console.${method}`);
      expect(originals[method]).toHaveBeenCalledExactlyOnceWith(
        `console.${method}`,
      );
      expect(originals[method].mock.contexts[0]).toBe(target);
    }
    uninstrument();
    for (const method of consoleMethods) {
      target[method]("console only");
      expect(originals[method]).toHaveBeenCalledTimes(2);
      expect(originals[method]).toHaveBeenLastCalledWith("console only");
    }
    await logger.flush();
    await logger.flush();
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({
      id,
      output: "User Ada",
      _is_merge: false,
    });
    expect(rows.slice(1).map((row) => row.output)).toEqual(
      consoleMethods.map((method) => `console.${method}`),
    );
    expect(rows.slice(1).map((row) => row.span_attributes?.log_level)).toEqual([
      "info",
      "trace",
      "debug",
      "info",
      "warn",
      "error",
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(7);
    for (const row of rows) {
      expect(row._is_merge).toBe(false);
      expect(row.metrics?.end).toBe(row.metrics?.start);
      expect(row.span_attributes?.type).toBe("log");
    }
  });

  test("severity methods each enqueue one complete initial row", async () => {
    const { logger, background, enqueue } = setup();
    const timestamp = new Date("2026-01-02T03:04:05.000Z");
    const levels = [
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ] as const;
    vi.useFakeTimers();
    vi.setSystemTime(timestamp);
    try {
      for (const [index, level] of levels.entries()) {
        const id = logger[level]("Worker {id} started", {
          metadata: { worker_id: "worker-1" },
        });
        expect(enqueue).toHaveBeenCalledTimes(index + 1);
        expect(enqueue.mock.calls[index][0]).toHaveLength(1);
        // Inspect initial writes before TestBackgroundLogger can merge updates.
        const row = await enqueue.mock.calls[index][0][0].get();
        expect(row).toMatchObject({
          id,
          project_id: "project",
          output: "Worker {id} started",
          _is_merge: false,
          span_attributes: { type: "log", name: null, log_level: level },
          metadata: { worker_id: "worker-1" },
          created: timestamp.toISOString(),
          metrics: {
            start: timestamp.getTime() / 1000,
            end: timestamp.getTime() / 1000,
          },
        });
      }
      await logger.flush();
      expect(await drain(background)).toHaveLength(levels.length);
      expect(enqueue).toHaveBeenCalledTimes(levels.length);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fmt captures stable templates and values without emitting or mutating metadata", async () => {
    const { logger, background, enqueue } = setup();
    const metadata = Object.freeze({
      source: "checkout",
      "braintrust.template": "old",
    });
    const events = [
      { userId: "user_123", amount: 12.5 },
      { userId: "user_456", amount: 8 },
    ];
    for (const [index, { userId, amount }] of events.entries()) {
      const formatted = logger.fmt`User ${userId} paid ${amount.toFixed(2)}`;
      expect(enqueue).toHaveBeenCalledTimes(index);
      logger.info(formatted, { metadata });
    }
    const rows = await drain(background);
    expect(rows.map((row) => row.output)).toEqual([
      "User user_123 paid 12.50",
      "User user_456 paid 8.00",
    ]);
    for (const [index, row] of rows.entries()) {
      expect(row.metadata).toEqual({
        source: "checkout",
        "braintrust.template": "User ${0} paid ${1}",
        "braintrust.template.parameter.0": events[index].userId,
        "braintrust.template.parameter.1": events[index].amount.toFixed(2),
      });
    }
    expect(metadata["braintrust.template"]).toBe("old");
  });

  test("fmt preserves cooked text, escaped placeholders, and interpolation boundaries", async () => {
    const { logger, background } = setup();
    const count = 3;
    logger.info(logger.fmt`line\n\t${count * 2}\\end`);
    logger.info(logger.fmt`literal \${value} and {braces} ${count}`);
    logger.info(logger.fmt`${"a"}${"b"}`);
    logger.info(logger.fmt`literal {braces} and no parameters`);
    const rows = await drain(background);
    expect(
      rows.map((row) => ({
        output: row.output,
        template: row.metadata?.["braintrust.template"],
      })),
    ).toEqual([
      { output: "line\n\t6\\end", template: "line\n\t${0}\\end" },
      {
        output: "literal ${value} and {braces} 3",
        template: "literal ${value} and {braces} ${0}",
      },
      { output: "ab", template: "${0}${1}" },
      {
        output: "literal {braces} and no parameters",
        template: "literal {braces} and no parameters",
      },
    ]);
  });

  test("fmt retains JSON parameter values and encodes undefined and bigint as text", async () => {
    const { logger, background } = setup();
    const values = [Object.freeze({ id: 42 }), false, null, 0, undefined, 123n];
    for (const value of values) logger.info(logger.fmt`${value}`);
    const rows = await drain(background);
    expect(rows.map((row) => row.output)).toEqual([
      "[object Object]",
      "false",
      "null",
      "0",
      "undefined",
      "123",
    ]);
    expect(
      rows.map((row) => row.metadata?.["braintrust.template.parameter.0"]),
    ).toEqual([{ id: 42 }, false, null, 0, "undefined", "123"]);
  });

  test("groups standalone messages per logger with independent row and span IDs", async () => {
    const { logger, background, state } = setup();
    logger.info("one");
    logger.warn({ event: "two" });
    const other = new Logger(
      state,
      new LazyValue(async () => ({
        org_id: "org",
        project: { id: "project", name: "test", fullInfo: {} },
      })),
      {},
    );
    other.info("three");
    const [one, two, three] = await drain(background);
    expect(two.output).toEqual({ event: "two" });
    expect(one.id).not.toBe(two.id);
    expect(one.span_id).not.toBe(two.span_id);
    expect(one.root_span_id).toBe(two.root_span_id);
    expect(three.root_span_id).not.toBe(one.root_span_id);
    expect(one.span_parents).toEqual([]);
  });

  test("uses the current ID generator for the first standalone log after late OpenTelemetry setup", async () => {
    vi.stubEnv("BRAINTRUST_LEGACY_IDS", "true");
    vi.stubEnv("BRAINTRUST_OTEL_COMPAT", undefined);
    try {
      const { logger, background, state } = setup();
      const root = logger.startSpan({ name: "before-otel" });
      state.contextManager.runInContext(root, () => logger.info("inside span"));
      root.end();
      expect(root.rootSpanId).toContain("-");

      // Change ID configuration after logger creation and reset the cache.
      vi.stubEnv("BRAINTRUST_OTEL_COMPAT", "true");
      state.resetIdGenState();
      logger.info("first standalone log");
      logger.warn("second standalone log");

      const logs = (await drain(background)).filter(
        (row) => row.span_attributes?.type === "log",
      );
      expect(logs).toHaveLength(3);
      expect(logs[0].root_span_id).toBe(root.rootSpanId);
      expect(logs[1].root_span_id).toMatch(/^[0-9a-f]{32}$/);
      expect(logs[1].span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(logs[2].root_span_id).toBe(logs[1].root_span_id);
      expect(logs[2].span_id).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  test("correlates SDK and console logs across awaits without modifying the active span", async () => {
    const { logger, background, state } = setup();
    const target = fakeConsole();
    const uninstrument = wrapConsole(target, { logger });
    const root = logger.startSpan({ name: "request" });
    await state.contextManager.runInContext(root, async () => {
      logger.info("one");
      await Promise.resolve();
      target.error("two");
      expect(state.contextManager.getCurrentSpan()).toBe(root);
    });
    root.end();
    const rows = await drain(background);
    const logs = rows.filter((row) => row.span_attributes?.type === "log");
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.id).not.toBe(root.id);
      expect(log.span_id).toBe(root.spanId);
      expect(log.root_span_id).toBe(root.rootSpanId);
      expect(log.span_parents).toEqual([]);
    }
    expect(state.contextManager.getCurrentSpan()).toBeUndefined();
    expect(rows.find((row) => row.id === root.id)?.span_attributes?.name).toBe(
      "request",
    );
    uninstrument();
    // Application log methods remain usable after span APIs have been used.
    expect(() => logger.info("outside")).not.toThrow();
  });

  test("uses context-manager IDs even without a native Braintrust span", async () => {
    const { logger, background, state } = setup();
    vi.spyOn(state.contextManager, "getParentSpanIds").mockReturnValue({
      rootSpanId: "otel-trace",
      spanParents: ["otel-span"],
    });
    logger.info("otel");
    expect((await drain(background))[0]).toMatchObject({
      root_span_id: "otel-trace",
      span_id: "otel-span",
    });
  });

  test("returns a row ID immediately and waits for explicit flush", async () => {
    const { logger, background, enqueue } = setup();
    let finishFlush!: () => void;
    const flush = vi.spyOn(background, "flush").mockReturnValue(
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      }),
    );
    const id = logger.info("synchronous");
    expect(typeof id).toBe("string");
    const pending = logger.flush();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishFlush();
    await pending;
    expect(flush).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await drain(background))[0].id).toBe(id);
  });
});

describe("wrapConsole", () => {
  test("wrapConsole() follows logger initialization and replacement until cleanup", async () => {
    const target = mockGlobalConsole();
    const first = setup();
    const second = setup();
    const state = _internalGetGlobalState();
    const previousLogger = state.currentLogger;
    const original = target.info;
    try {
      state.currentLogger = undefined;
      const uninstrument = wrapConsole();
      console.info("before initialization");
      expect(first.enqueue).not.toHaveBeenCalled();
      state.currentLogger = first.logger;
      console.info("captured by first logger");
      state.currentLogger = second.logger;
      console.info("captured by second logger");
      expect(first.enqueue).toHaveBeenCalledTimes(1);
      expect(second.enqueue).toHaveBeenCalledTimes(1);
      expect(original).toHaveBeenCalledTimes(3);
      expect((await drain(first.background)).map((row) => row.output)).toEqual([
        "captured by first logger",
      ]);
      expect((await drain(second.background))[0].output).toBe(
        "captured by second logger",
      );
      uninstrument();
      console.info("Console output only");
      expect(original).toHaveBeenCalledTimes(4);
      expect(second.enqueue).toHaveBeenCalledTimes(1);
    } finally {
      state.currentLogger = previousLogger;
    }
  });

  test("rewrapping and cleanup preserve the current destination without reactivating older wraps", async () => {
    const first = setup();
    const second = setup();
    const target = fakeConsole();
    const original = target.info;
    const stopFirst = wrapConsole(target, { logger: first.logger });
    target.info("first");
    const wrapped = target.info;
    const stopSecond = wrapConsole(target, { logger: second.logger });
    expect(target.info).toBe(wrapped);
    stopFirst();
    stopFirst();
    target.info("second");
    stopSecond();
    stopSecond();
    target.info("console only");
    const stopThird = wrapConsole(target, { logger: second.logger });
    expect(target.info).toBe(wrapped);
    stopSecond();
    target.info("captured again");
    stopThird();
    target.info("console only again");
    expect(original).toHaveBeenCalledTimes(5);
    expect((await drain(first.background)).map((row) => row.output)).toEqual([
      "first",
    ]);
    expect((await drain(second.background)).map((row) => row.output)).toEqual([
      "second",
      "captured again",
    ]);
  });

  test("cleanup affects only its console; direct logging and unrelated methods stay enabled", async () => {
    const first = setup();
    const second = setup();
    const time = vi.fn();
    const firstConsole = { ...fakeConsole(), time };
    const secondConsole = fakeConsole();
    const stopFirst = wrapConsole(firstConsole, { logger: first.logger });
    const stopSecond = wrapConsole(secondConsole, { logger: second.logger });
    expect(firstConsole.time).toBe(time);
    stopFirst();
    firstConsole.info("console only");
    secondConsole.info("other console");
    first.logger.info("direct logger call");
    stopSecond();
    expect((await drain(first.background)).map((row) => row.output)).toEqual([
      "direct logger call",
    ]);
    expect((await drain(second.background)).map((row) => row.output)).toEqual([
      "other console",
    ]);
  });

  test("nested wrapping captures once and cleanup preserves third-party patches without reviving older capture", () => {
    const first = setup();
    const second = setup();
    const target = fakeConsole();
    const original = target.info;
    const stopFirst = wrapConsole(target, { logger: first.logger });
    const firstWrapper = target.info;
    target.info = vi.fn((...args) => firstWrapper(...args));
    const stopSecond = wrapConsole(target, { logger: second.logger });
    target.info("captured once");
    expect(first.enqueue).not.toHaveBeenCalled();
    expect(second.enqueue).toHaveBeenCalledTimes(1);
    const secondWrapper = target.info;
    const thirdParty = vi.fn((...args) => secondWrapper(...args));
    target.info = thirdParty;
    stopSecond();
    expect(target.info).toBe(thirdParty);
    target.info("console only");
    expect(thirdParty).toHaveBeenCalledExactlyOnceWith("console only");
    expect(original).toHaveBeenCalledTimes(2);
    expect(original).toHaveBeenLastCalledWith("console only");
    expect(first.enqueue).not.toHaveBeenCalled();
    expect(second.enqueue).toHaveBeenCalledTimes(1);
    stopFirst();
  });

  test("nested console calls capture once and native exceptions do not leave the guard active", async () => {
    const { logger, background, enqueue } = setup();
    const target = fakeConsole();
    target.trace.mockImplementation((...args) => target.error(...args));
    const error = new Error("console failure");
    const original = target.info.mockImplementation(() => {
      throw error;
    });
    wrapConsole(target, { logger });
    target.trace("nested");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(() => target.info("failure")).toThrow(error);
    expect(original).toHaveBeenCalledTimes(1);
    target.warn("after failure");
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect((await drain(background)).map((row) => row.output)).toEqual([
      "nested",
      "failure",
      "after failure",
    ]);
  });

  test("object formatting hooks run only in the native console, not during capture", async () => {
    const { logger, background } = setup();
    const output: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        callback();
      },
    });
    const target = new Console({ stdout, stderr: stdout, colorMode: false });
    const stop = wrapConsole(target, { logger });
    let inspections = 0;
    const customInspect = vi.fn(() => `custom-${++inspections}`);
    const value = { id: 42, [inspect.custom]: customInspect };
    const calls = [[value], ["value %o", value], ["value %s", value]];
    let stringCalls = 0;
    let numberCalls = 0;
    let jsonCalls = 0;
    const toString = vi.fn(() => `string-${++stringCalls}`);
    const valueOf = vi.fn(() => ++numberCalls);
    const toJSON = vi.fn(() => ({ serialization: ++jsonCalls }));
    try {
      for (const [index, args] of calls.entries()) {
        target.info(...args);
        expect(customInspect).toHaveBeenCalledTimes(index + 1);
      }
      target.info("%s", { id: 42, toString });
      target.info("%d", { id: 42, valueOf });
      target.info("%j", { id: 42, toJSON });
      expect.soft(toString).toHaveBeenCalledTimes(1);
      expect.soft(valueOf).toHaveBeenCalledTimes(1);
      expect.soft(toJSON).toHaveBeenCalledTimes(1);
      expect(output).toEqual([
        "custom-1\n",
        "value custom-2\n",
        "value custom-3\n",
        "string-1\n",
        "1\n",
        '{"serialization":1}\n',
      ]);
      const rows = await drain(background);
      expect(rows).toHaveLength(6);
      for (const row of rows.slice(0, 4))
        expect(row.output).toContain("id: 42");
      for (const row of rows.slice(1)) {
        expect(row.metadata?.["braintrust.template.parameter.0"]).toContain(
          "id: 42",
        );
      }
    } finally {
      stop();
      stdout.destroy();
    }
  });

  test("preserves primitive formatting, parameters, errors, and circular objects without calling toJSON", async () => {
    const { logger, background } = setup();
    const target = fakeConsole();
    wrapConsole(target, { logger });
    target.info("Payment %s attempt %d", "pay_123", 2);
    target.error(new Error("payment failed"));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    target.info("value %o", circular);
    const toJSON = vi.fn(() => {
      throw new Error("bad serializer");
    });
    target.info("value %j", { id: 42, toJSON });
    const rows = await drain(background);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      output: "Payment pay_123 attempt 2",
      metadata: {
        "logger.name": "console",
        "braintrust.template": "Payment %s attempt %d",
        "braintrust.template.parameter.0": "pay_123",
        "braintrust.template.parameter.1": 2,
      },
    });
    expect(rows[1].output).toContain("Error: payment failed");
    expect(rows[2].output).toContain("Circular");
    expect(toJSON).not.toHaveBeenCalled();
    expect(rows[3].output).toContain("id: 42");
  });

  test("fallback formatting serializes parameters once and preserves BigInt arguments", async () => {
    const { logger, background } = setup();
    const target = fakeConsole();
    wrapConsole(target, { logger });
    let serializations = 0;
    const toJSON = vi.fn(() => ({ serialization: ++serializations }));
    const format = iso.formatLogMessage;
    iso.formatLogMessage = undefined;
    try {
      target.info("Payment %s %d %%", "pay_123", 2, { attempt: 1 });
      target.info("value %s", { toJSON });
      target.info("count", 1n);
      target.info(2n);
    } finally {
      iso.formatLogMessage = format;
    }
    const rows = await drain(background);
    expect.soft(toJSON).toHaveBeenCalledTimes(1);
    expect
      .soft(rows.map((row) => row.output))
      .toEqual([
        'Payment %s %d %% pay_123 2 {"attempt":1}',
        'value %s {"serialization":1}',
        "count 1",
        "2",
      ]);
    expect.soft(rows[1].metadata).toMatchObject({
      "braintrust.template": "value %s",
      "braintrust.template.parameter.0": '{"serialization":1}',
    });
    expect(rows[2].metadata?.["braintrust.template.parameter.0"]).toBe("1");
  });

  test("SDK output uses saved console methods across awaits, rewrapping, and cleanup", async () => {
    const target = mockGlobalConsole();
    const { logger, enqueue } = setup();
    const sdkState = _internalGetGlobalState();
    vi.spyOn(sdkState, "getDebugLogLevel").mockReturnValue("warn");
    vi.spyOn(sdkState, "hasDebugLogLevelOverride").mockReturnValue(true);
    // Before wrapping, SDK output still uses the current console.
    debugLogger.warn("before wrapping");
    const originals = {
      warn: target.warn,
      error: target.error,
      log: target.log,
    };
    const stopFirst = wrapConsole(console, { logger });
    const firstWrapper = console.warn;
    const thirdParty = vi.fn((...args) => firstWrapper(...args));
    console.warn = thirdParty;
    const stopSecond = wrapConsole(console, { logger });
    try {
      await Promise.resolve();
      debugLogger.warn("SDK warning");
      expect(debugLogger.notice.warn("SDK notice")).toBe(true);
      logError("evaluation error", false);
      new SimpleProgressReporter().start("evaluation", 1);
      expect(originals.warn).toHaveBeenCalledTimes(3);
      expect(originals.warn).toHaveBeenCalledWith(
        "[braintrust]",
        "SDK warning",
      );
      expect(originals.warn).toHaveBeenCalledWith("[braintrust]", "SDK notice");
      expect(originals.warn.mock.contexts[0]).toBe(console);
      expect(originals.error).toHaveBeenCalledWith("evaluation error");
      expect(originals.log).toHaveBeenCalledWith(
        "Running evaluator evaluation",
      );
      expect(thirdParty).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      console.warn("application log");
      expect(thirdParty).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      stopSecond();
      debugLogger.warn("after cleanup");
      expect(originals.warn).toHaveBeenLastCalledWith(
        "[braintrust]",
        "after cleanup",
      );
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      stopFirst();
      stopSecond();
    }
  });
});
