import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  BraintrustState,
  _exportsForTestingOnly,
  initLogger,
  login,
} from "./logger";
import {
  debugLogger,
  getEnvDebugLogLevel,
  resetDebugLoggerForTests,
} from "./debug-logger";
import { newGlobalTracingChannel } from "./global-instrumentation-hooks";
import { configureNode } from "./node/config";

configureNode();

describe("debug logger", () => {
  const originalLogLevel = process.env.BRAINTRUST_DEBUG_LOG_LEVEL;

  beforeEach(() => {
    delete process.env.BRAINTRUST_DEBUG_LOG_LEVEL;
    resetDebugLoggerForTests();
    _exportsForTestingOnly.simulateLogoutForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.BRAINTRUST_DEBUG_LOG_LEVEL;
    } else {
      process.env.BRAINTRUST_DEBUG_LOG_LEVEL = originalLogLevel;
    }
    resetDebugLoggerForTests();
    _exportsForTestingOnly.simulateLogoutForTests();
    vi.restoreAllMocks();
  });

  test("info level emits info, warn, and error but not debug", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const state = {
      getDebugLogLevel: () => "info" as const,
      hasDebugLogLevelOverride: () => true,
    };

    const scopedLogger = debugLogger.forState(state);

    scopedLogger.info("info");
    scopedLogger.warn("warn");
    scopedLogger.error("error");
    scopedLogger.debug("debug");

    expect(logSpy).toHaveBeenCalledWith("[braintrust]", "info");
    expect(warnSpy).toHaveBeenCalledWith("[braintrust]", "warn");
    expect(errorSpy).toHaveBeenCalledWith("[braintrust]", "error");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  test("debug level emits debug", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const state = {
      getDebugLogLevel: () => "debug" as const,
      hasDebugLogLevelOverride: () => true,
    };

    debugLogger.forState(state).debug("debug");

    expect(debugSpy).toHaveBeenCalledWith("[braintrust]", "debug");
  });

  test("global hook failures are logged without escaping the provider call", () => {
    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "error";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const subscriberError = new Error("subscriber failed");
    const channel = newGlobalTracingChannel<Record<string, unknown>>(
      `test:debug-logger:${Math.random()}`,
    );
    channel.subscribe({
      start() {
        throw subscriberError;
      },
    });

    expect(channel.traceSync(() => "result", {})).toBe("result");
    expect(errorSpy).toHaveBeenCalledWith(
      "[braintrust]",
      "Global instrumentation hook error:",
      subscriberError,
    );
  });

  test("default logger resolves the global SDK state", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    _exportsForTestingOnly.setInitialTestState();
    const state = _exportsForTestingOnly.simulateLogoutForTests();
    state.setDebugLogLevel("warn");

    debugLogger.warn("global warning");

    expect(warnSpy).toHaveBeenCalledWith("[braintrust]", "global warning");
  });

  test("BRAINTRUST_DEBUG_LOG_LEVEL accepts error, warn, info, and debug", () => {
    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "error";
    expect(getEnvDebugLogLevel()).toBe("error");

    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "warn";
    expect(getEnvDebugLogLevel()).toBe("warn");

    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "info";
    expect(getEnvDebugLogLevel()).toBe("info");

    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "debug";
    expect(getEnvDebugLogLevel()).toBe("debug");
  });

  test("BRAINTRUST_DEBUG_LOG_LEVEL rejects invalid values and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "true";

    expect(getEnvDebugLogLevel()).toBeUndefined();
    expect(getEnvDebugLogLevel()).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[braintrust]",
      'Invalid BRAINTRUST_DEBUG_LOG_LEVEL value "true". Expected "error", "warn", "info", or "debug".',
    );
  });

  test("initLogger updates the state debug log level", () => {
    const state = new BraintrustState({});

    initLogger({ state, debugLogLevel: "debug" });

    expect(state.getDebugLogLevel()).toBe("debug");
  });

  test("explicitly disabling debug logging overrides the env var", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.BRAINTRUST_DEBUG_LOG_LEVEL = "info";

    const state = new BraintrustState({ debugLogLevel: false });
    debugLogger.forState(state).info("info");

    expect(logSpy).not.toHaveBeenCalled();
  });

  test("login updates debug log level even when the state is already logged in", async () => {
    const state = await _exportsForTestingOnly.simulateLoginForTests();

    await login({ debugLogLevel: "debug" });

    expect(state.getDebugLogLevel()).toBe("debug");
  });

  test("serialized state preserves the debug log level", async () => {
    const state = new BraintrustState({});
    state.appUrl = "https://braintrust.dev";
    state.appPublicUrl = "https://braintrust.dev";
    state.apiUrl = "https://api.braintrust.dev";
    state.proxyUrl = "https://proxy.braintrust.dev";
    state.orgName = "test-org";
    state.loginToken = "test-token";
    state.loggedIn = true;
    state.setDebugLogLevel("debug");

    const deserialized = BraintrustState.deserialize(state.serialize());

    expect(deserialized.getDebugLogLevel()).toBe("debug");
  });
});
