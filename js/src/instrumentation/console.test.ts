import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { _exportsForTestingOnly, initLogger } from "../logger";
import {
  _resetConsoleInstrumentationForTests,
  instrumentConsole,
} from "./console";

const CONSOLE_METHODS = [
  "debug",
  "info",
  "warn",
  "error",
  "log",
  "trace",
  "assert",
] as const;

describe("instrumentConsole", () => {
  let memoryLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  const consoleSpies: Partial<
    Record<(typeof CONSOLE_METHODS)[number], ReturnType<typeof vi.spyOn>>
  > = {};

  beforeEach(async () => {
    _resetConsoleInstrumentationForTests();
    await _exportsForTestingOnly.simulateLoginForTests();
    memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    for (const method of CONSOLE_METHODS) {
      consoleSpies[method] = vi
        .spyOn(globalThis.console, method)
        .mockImplementation(() => undefined);
    }
  });

  afterEach(async () => {
    _resetConsoleInstrumentationForTests();
    vi.restoreAllMocks();
    await memoryLogger.flush();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  test("forwards supported console methods without changing console calls", async () => {
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const stop = instrumentConsole({ logger });

    globalThis.console.debug("debug", { value: 1 });
    globalThis.console.info("hello %s", "world");
    globalThis.console.warn("warn", 2);
    globalThis.console.error(new Error("failed"));
    globalThis.console.log("plain");
    globalThis.console.trace("trace");
    globalThis.console.assert(true, "not captured");
    globalThis.console.assert(false, "missing %s", "value");
    stop();

    for (const method of CONSOLE_METHODS) {
      expect(consoleSpies[method]).toHaveBeenCalled();
    }

    await memoryLogger.flush();
    const rows = (await memoryLogger.drain()) as any[];
    expect(rows.map((row) => row.output)).toEqual([
      'debug {"value":1}',
      "hello world",
      "warn 2",
      expect.stringContaining("Error: failed"),
      "plain",
      "trace",
      "Assertion failed: missing value",
    ]);
    expect(rows.map((row) => row.context.otel.log.severity_number)).toEqual([
      5, 9, 13, 17, 9, 1, 17,
    ]);
    expect(rows.map((row) => row.span_attributes.type)).toEqual(
      Array(7).fill("log"),
    );
    expect(rows[3].error).toEqual(expect.stringContaining("Error: failed"));
    expect(rows[6].error).toBe("Assertion failed: missing value");
  });

  test("does not capture console calls made internally by another console method", async () => {
    consoleSpies.assert?.mockImplementation(
      (condition: unknown, ...args: unknown[]) => {
        if (!condition) {
          globalThis.console.warn("Assertion failed:", ...args);
        }
      },
    );
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const stop = instrumentConsole({ logger });

    globalThis.console.assert(false, "nested warning");
    stop();

    expect(consoleSpies.warn).toHaveBeenCalledWith(
      "Assertion failed:",
      "nested warning",
    );
    await memoryLogger.flush();
    const rows = (await memoryLogger.drain()) as any[];
    expect(rows.map((row) => row.output)).toEqual([
      "Assertion failed: nested warning",
    ]);
  });

  test("captures only selected levels and stops after cleanup", async () => {
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const stop = instrumentConsole({ logger, levels: ["warn", "error"] });

    globalThis.console.info("ignored");
    globalThis.console.warn("captured");
    stop();
    globalThis.console.error("stopped");

    await memoryLogger.flush();
    const rows = (await memoryLogger.drain()) as any[];
    expect(rows.map((row) => row.output)).toEqual(["captured"]);
  });

  test("uses the current logger when none is provided", async () => {
    initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const stop = instrumentConsole({ levels: ["log"] });

    globalThis.console.log("current logger");
    stop();

    await memoryLogger.flush();
    const [row] = (await memoryLogger.drain()) as any[];
    expect(row.output).toBe("current logger");
  });

  test("is idempotent for the same logger and levels", async () => {
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const firstStop = instrumentConsole({ logger, levels: ["log"] });
    const secondStop = instrumentConsole({ logger, levels: ["log"] });

    globalThis.console.log("once");
    firstStop();
    globalThis.console.log("still active");
    secondStop();
    globalThis.console.log("stopped");

    await memoryLogger.flush();
    const rows = (await memoryLogger.drain()) as any[];
    expect(rows.map((row) => row.output)).toEqual(["once", "still active"]);
  });

  test("contains logging failures", () => {
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    vi.spyOn(logger, "info").mockImplementation(() => {
      throw new Error("logging failed");
    });
    const stop = instrumentConsole({ logger, levels: ["log"] });

    expect(() => globalThis.console.log("still works")).not.toThrow();
    expect(consoleSpies.log).toHaveBeenCalledWith("still works");
    stop();
  });
});
