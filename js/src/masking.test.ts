import { expect, test, describe, beforeEach, afterEach } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  wrapTraced,
  currentSpan,
  setMaskingFunction,
} from "./logger";
import { configureNode } from "./node/config";
import { configureInstrumentation, registry } from "./instrumentation/registry";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "./span-origin";

configureNode();

describe("masking functionality", () => {
  let memoryLogger: any;

  beforeEach(async () => {
    registry.disable();
    await _exportsForTestingOnly.simulateLoginForTests();
    memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    configureInstrumentation({ spanCustomizers: [] });
    setMaskingFunction(null); // Clear masking function
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("basic masking with logger", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "password" || key === "api_key") {
            masked[key] = "REDACTED";
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    setMaskingFunction(maskingFunction);

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    logger.log({
      input: { query: "login", password: "secret123" },
      output: { status: "success", api_key: "sk-12345" },
      metadata: { user: "test", token: "safe" },
    });

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    expect(events).toHaveLength(1);
    const event = events[0];

    expect(event.input).toEqual({ query: "login", password: "REDACTED" });
    expect(event.output).toEqual({ status: "success", api_key: "REDACTED" });
    expect(event.metadata).toEqual({ user: "test", token: "safe" });
  });

  test("masking with scores and metadata", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "secret" || key === "token") {
            masked[key] = "HIDDEN";
          } else if (typeof value === "string" && value.includes("sensitive")) {
            masked[key] = value.replace(/\bsensitive\b/g, "REDACTED");
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    setMaskingFunction(maskingFunction);

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    logger.log({
      input: { message: "This is sensitive data", secret: "top-secret" },
      output: { result: "sensitive information processed" },
      scores: { accuracy: 0.95 },
      metadata: { token: "auth-token", safe: "non-sensitive" },
    });

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    expect(events).toHaveLength(1);
    const event = events[0];

    expect(event.input).toEqual({
      message: "This is REDACTED data",
      secret: "HIDDEN",
    });
    expect(event.output).toEqual({
      result: "REDACTED information processed",
    });
    expect(event.scores).toEqual({ accuracy: 0.95 });
    expect(event.metadata).toEqual({
      token: "HIDDEN",
      safe: "non-REDACTED",
    });
  });

  test("masking propagates through spans", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "api_key") {
            masked[key] = "XXX";
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    setMaskingFunction(maskingFunction);

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    const parentSpan = logger.startSpan({ name: "parent" });
    parentSpan.log({
      input: { api_key: "parent-key", data: "parent-data" },
    });

    const childSpan = parentSpan.startSpan({ name: "child" });
    childSpan.log({
      output: { api_key: "child-key", result: "child-result" },
    });
    childSpan.end();

    parentSpan.end();

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    expect(events).toHaveLength(2);

    const parentEvent = events.find(
      (e: any) => e.span_attributes?.name === "parent",
    );
    const childEvent = events.find(
      (e: any) => e.span_attributes?.name === "child",
    );

    expect(parentEvent.input).toEqual({ api_key: "XXX", data: "parent-data" });
    expect(childEvent.output).toEqual({
      api_key: "XXX",
      result: "child-result",
    });
  });

  test("masking with traced functions", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "email") {
            masked[key] = "user@REDACTED.com";
          } else if (key === "ssn") {
            masked[key] = "XXX-XX-XXXX";
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    setMaskingFunction(maskingFunction);

    const processUserData = wrapTraced(
      async function processUserData(userData: any) {
        currentSpan().log({
          input: userData,
          output: { processed: true, ...userData },
        });
        return { processed: true, ...userData };
      },
      { name: "processUserData" },
    );

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    const span = logger.startSpan({ name: "main" });
    const result = await processUserData({
      name: "John Doe",
      email: "john@example.com",
      ssn: "123-45-6789",
    });
    span.log({ output: result });
    span.end();

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    const processEvent = events.find(
      (e: any) => e.span_attributes?.name === "processUserData",
    );
    expect(processEvent.input).toEqual({
      name: "John Doe",
      email: "user@REDACTED.com",
      ssn: "XXX-XX-XXXX",
    });
    expect(processEvent.output).toEqual({
      processed: true,
      name: "John Doe",
      email: "user@REDACTED.com",
      ssn: "XXX-XX-XXXX",
    });
  });

  test("masking with expected field", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "credit_card") {
            masked[key] = "XXXX-XXXX-XXXX-XXXX";
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    setMaskingFunction(maskingFunction);

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    logger.log({
      input: {
        transaction: "purchase",
        credit_card: "1234-5678-9012-3456",
      },
      expected: {
        status: "approved",
        credit_card: "9876-5432-1098-7654",
      },
      metadata: { merchant: "store", safe_field: "public" },
    });

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    expect(events).toHaveLength(1);
    const event = events[0];

    expect(event.input).toEqual({
      transaction: "purchase",
      credit_card: "XXXX-XXXX-XXXX-XXXX",
    });
    expect(event.expected).toEqual({
      status: "approved",
      credit_card: "XXXX-XXXX-XXXX-XXXX",
    });
    expect(event.metadata).toEqual({
      merchant: "store",
      safe_field: "public",
    });
  });

  test("complex nested masking", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};

        if (Array.isArray(data)) {
          return data.map((item) => maskingFunction(item));
        }

        for (const [key, value] of Object.entries(data)) {
          if (key === "secrets" && Array.isArray(value)) {
            masked[key] = value.map(() => "REDACTED");
          } else if (key === "tokens" && typeof value === "object") {
            masked[key] = Object.keys(value ?? {}).reduce((acc: any, k) => {
              acc[k] = "REDACTED";
              return acc;
            }, {});
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    setMaskingFunction(maskingFunction);

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    logger.log({
      input: {
        users: [
          { id: 1, secrets: ["secret1", "secret2"] },
          { id: 2, secrets: ["secret3", "secret4"] },
        ],
        tokens: {
          access: "access-token-123",
          refresh: "refresh-token-456",
        },
        nested: {
          level1: {
            level2: {
              secrets: ["deep-secret"],
              public: "public-data",
            },
          },
        },
      },
    });

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    expect(events).toHaveLength(1);
    const event = events[0];

    expect(event.input.users).toEqual([
      { id: 1, secrets: ["REDACTED", "REDACTED"] },
      { id: 2, secrets: ["REDACTED", "REDACTED"] },
    ]);
    expect(event.input.tokens).toEqual({
      access: "REDACTED",
      refresh: "REDACTED",
    });
    expect(event.input.nested.level1.level2).toEqual({
      secrets: ["REDACTED"],
      public: "public-data",
    });
  });

  test("masking can be disabled", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "password") {
            masked[key] = "REDACTED";
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    // First set masking
    setMaskingFunction(maskingFunction);

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    logger.log({ input: { password: "visible1" } });

    // Now disable masking
    setMaskingFunction(null);

    logger.log({ input: { password: "visible2" } });

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    expect(events).toHaveLength(2);

    // Disabling before flush also affects previously queued records.
    expect(events[0].input).toEqual({ password: "visible1" });
    // Second event should not be masked
    expect(events[1].input).toEqual({ password: "visible2" });
  });

  test("masking preserves data types", async () => {
    const maskingFunction = (data: any): any => {
      if (typeof data === "object" && data !== null) {
        const masked: any = Array.isArray(data) ? [] : {};
        for (const [key, value] of Object.entries(data)) {
          if (key === "secret_number") {
            masked[key] = -1;
          } else if (key === "secret_bool") {
            masked[key] = false;
          } else if (key === "secret_null") {
            masked[key] = null;
          } else if (key === "secret_array") {
            masked[key] = [];
          } else if (typeof value === "object") {
            masked[key] = maskingFunction(value);
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }
      return data;
    };

    setMaskingFunction(maskingFunction);

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });

    logger.log({
      input: {
        secret_number: 42,
        secret_bool: true,
        secret_null: "should be null",
        secret_array: ["a", "b", "c"],
        normal_string: "unchanged",
        normal_number: 123,
      },
    });

    await memoryLogger.flush();
    const events = await memoryLogger.drain();

    expect(events).toHaveLength(1);
    const event = events[0];

    expect(event.input.secret_number).toBe(-1);
    expect(typeof event.input.secret_number).toBe("number");
    expect(event.input.secret_bool).toBe(false);
    expect(typeof event.input.secret_bool).toBe("boolean");
    expect(event.input.secret_null).toBe(null);
    expect(event.input.secret_array).toEqual([]);
    expect(Array.isArray(event.input.secret_array)).toBe(true);
    expect(event.input.normal_string).toBe("unchanged");
    expect(event.input.normal_number).toBe(123);
  });

  test("masking failures redact fields without leaking exception details", async () => {
    setMaskingFunction((data) => {
      if (data === "safe output") return data;
      throw new TypeError("private exception detail");
    });

    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    logger.log({
      input: { password: "private input" },
      output: "safe output",
      expected: "private expected",
      metadata: { token: "private metadata" },
      scores: { accuracy: 0.85 },
      metrics: { accuracy: 0.95 },
      error: "existing application error",
    });

    const [event] = await memoryLogger.drain();
    expect(event.input).toEqual(expect.any(String));
    expect(event.expected).toEqual(expect.any(String));
    expect(event.metadata).toEqual({ error: expect.any(String) });
    expect(event.output).toBe("safe output");
    expect(event.scores).toBeUndefined();
    expect(event.metrics).toBeUndefined();
    expect(event.error).toContain("existing application error");
    expect(event.error).toContain("scores");
    expect(event.error).toContain("metrics");
    expect(JSON.stringify(event)).not.toContain("private");
  });

  test("late masking sees merged fields on manual spans", async () => {
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const span = logger.startSpan({
      name: "manual",
      event: { metadata: { password: "private" } },
    });
    span.log({ metadata: { redact: true } });
    span.end();

    setMaskingFunction((data) => {
      if (data && typeof data === "object" && "redact" in data) {
        return { ...data, password: "redacted" };
      }
      return data;
    });

    expect(await memoryLogger.drain()).toEqual([
      expect.objectContaining({
        id: span.id,
        project_id: "test-project-id",
        metadata: { password: "redacted", redact: true },
      }),
    ]);
  });

  test("masking runs after customizers and can be replaced or disabled independently", async () => {
    configureInstrumentation({
      spanCustomizers: [
        {
          onSpanExport(data) {
            if (typeof data.output === "string") data.output += ":customized";
            return data;
          },
        },
      ],
    });
    const logger = initLogger({
      projectName: "test",
      projectId: "test-project-id",
    });
    const logOutput = () => {
      const span = logger.startSpan(
        withSpanInstrumentationName(
          { name: "provider" },
          INSTRUMENTATION_NAMES.OPENAI,
        ),
      );
      span.log({ output: "private" });
      span.end();
    };
    setMaskingFunction((data) =>
      typeof data === "string" ? `${data}:obsolete` : data,
    );
    setMaskingFunction((data) =>
      data === "private:customized" ? "redacted" : data,
    );
    logOutput();
    expect(await memoryLogger.drain()).toEqual([
      expect.objectContaining({ output: "redacted" }),
    ]);

    setMaskingFunction(null);
    logOutput();
    expect(await memoryLogger.drain()).toEqual([
      expect.objectContaining({ output: "private:customized" }),
    ]);
  });
});
