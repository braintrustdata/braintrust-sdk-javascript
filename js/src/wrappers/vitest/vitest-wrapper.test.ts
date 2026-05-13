import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
  expectTypeOf,
} from "vitest";
import { configureNode } from "../../node/config";
import { wrapVitest } from "./index";
import { wrapExpect } from "./expect-wrapper";
import {
  _exportsForTestingOnly,
  type TestBackgroundLogger,
} from "../../logger";
import type { BraintrustVitest } from "./types";
import * as logger from "../../logger";
import { getExperimentContext } from "./wrapper";
import {
  getVitestContextManager,
  _resetContextManager,
} from "./context-manager";
import { flushExperimentWithSync } from "./flush-manager";

configureNode();

// ✅ Set up test state and background logger at module level for unit tests
_exportsForTestingOnly.setInitialTestState();
await _exportsForTestingOnly.simulateLoginForTests();
_exportsForTestingOnly.useTestBackgroundLogger();

// ✅ STEP 2: Mock initDataset and initExperiment to avoid network calls
vi.spyOn(logger, "initDataset").mockReturnValue({
  insert: vi.fn(() => "test-example-id"),
} as any);

const initExperimentSpy = vi
  .spyOn(logger, "initExperiment")
  .mockImplementation((projectOrOptions: string | any, options?: any) => {
    const experimentOptions =
      typeof projectOrOptions === "string" ? options : projectOrOptions;
    const projectName =
      typeof projectOrOptions === "string"
        ? projectOrOptions
        : (projectOrOptions.project ??
          projectOrOptions.projectId ??
          "test-project");

    return _exportsForTestingOnly.initTestExperiment(
      experimentOptions?.experiment || "test-experiment",
      projectName,
    );
  });

describe("Braintrust Vitest Wrapper", () => {
  // Test logger already set up at module level

  test("vitest is installed", () => {
    expect(test).toBeDefined();
    expect(expect).toBeDefined();
    expect(describe).toBeDefined();
  });

  describe("validation", () => {
    test("wrapVitest requires test, describe, and expect", () => {
      expect(() => {
        wrapVitest({} as any);
      }).toThrow("test is required");

      expect(() => {
        wrapVitest({ test } as any);
      }).toThrow("describe is required");

      expect(() => {
        wrapVitest({ test, describe } as any);
      }).toThrow("expect is required");
    });

    test("returns wrapped vitest methods", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      expect(bt.test).toBeDefined();
      expect(bt.it).toBeDefined();
      expect(bt.describe).toBeDefined();
      expect(bt.expect).toBeDefined();
      expect(typeof bt.expect).toBe("function");
      expect(bt.beforeAll).toBeDefined();
      expect(bt.afterAll).toBeDefined();
      expect(bt.logOutputs).toBeDefined();
      expect(bt.logFeedback).toBeDefined();
      expect(bt.getCurrentSpan).toBeDefined();
    });

    test("wrapping preserves types", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      // Verify return type is correct
      expectTypeOf(bt).toMatchTypeOf<BraintrustVitest>();

      // Verify methods have correct types
      expectTypeOf(bt.test).toBeFunction();
      expectTypeOf(bt.it).toBeFunction();
      expectTypeOf(bt.describe).toBeFunction();
      expectTypeOf(bt.logOutputs).toBeFunction();
      expectTypeOf(bt.logFeedback).toBeFunction();
      expectTypeOf(bt.getCurrentSpan).toBeFunction();
    });
  });

  describe("wrapper behavior", () => {
    test("handles optional beforeAll/afterAll/beforeEach/afterEach", () => {
      // Should not throw when optional methods are missing
      const bt = wrapVitest({
        test,
        expect,
        describe,
      });

      expect(bt.beforeAll).toBeDefined();
      expect(bt.afterAll).toBeDefined();
      expect(bt.beforeEach).toBeUndefined();
      expect(bt.afterEach).toBeUndefined();

      // Should work when provided
      const btWithHooks = wrapVitest({
        test,
        expect,
        describe,
        beforeAll,
        afterAll,
      });

      expect(btWithHooks.beforeAll).toBe(beforeAll);
      expect(btWithHooks.afterAll).toBe(afterAll);
    });

    test("wrapping test function calls original test", () => {
      const mockTest = vi.fn();
      const bt = wrapVitest({
        test: mockTest as any,
        expect,
        describe,
        beforeAll,
        afterAll,
      });

      bt.test("test name", () => {});

      expect(mockTest).toHaveBeenCalledWith(
        "test name",
        undefined,
        expect.any(Function),
      );
    });

    test("wrapping describe function calls original describe", () => {
      const mockDescribe = vi.fn();
      const bt = wrapVitest({
        test,
        expect,
        describe: mockDescribe as any,
        beforeAll,
        afterAll,
      });

      bt.describe("suite name", () => {});

      expect(mockDescribe).toHaveBeenCalledWith(
        "suite name",
        expect.any(Function),
      );
    });

    test("it is an alias for test", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      expect(bt.it).toBe(bt.test);
    });
  });

  describe("API surface", () => {
    test("getCurrentSpan returns NOOP_SPAN when called outside test", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });
      const span = bt.getCurrentSpan();

      expect(span).toBeDefined();
      expect(span).not.toBeNull();
      if (span) {
        expect(span.log).toBeDefined();
      }
    });
  });

  describe("vitest modifiers", () => {
    test("wrapped test supports skip modifier", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      expect(bt.test.skip).toBeDefined();
      expect(typeof bt.test.skip).toBe("function");
    });

    test("wrapped test supports only modifier", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      expect(bt.test.only).toBeDefined();
      expect(typeof bt.test.only).toBe("function");
    });

    test("wrapped test supports concurrent modifier", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      expect(bt.test.concurrent).toBeDefined();
      expect(typeof bt.test.concurrent).toBe("function");
    });

    test("wrapped test supports todo modifier", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      expect(bt.test.todo).toBeDefined();
    });

    test("wrapped test supports each modifier", () => {
      const bt = wrapVitest({ test, expect, describe, beforeAll, afterAll });

      expect(bt.test.each).toBeDefined();
    });
  });

  describe("modifiers work with Braintrust config", () => {
    const bt = wrapVitest(
      { test, expect, describe, beforeAll, afterAll },
      { projectName: "modifier-config-test", displaySummary: false },
    );

    // Test that concurrent modifier accepts Braintrust config with Vitest options
    bt.test.concurrent(
      "concurrent test with config",
      { input: "concurrent-input", expected: "concurrent-output" },
      async (ctx) => {
        expect(ctx.input).toBe("concurrent-input");
        expect(ctx.expected).toBe("concurrent-output");
        return "concurrent-output";
      },
    );

    // Test that skip modifier properly wraps (won't execute but should not error)
    bt.test.skip(
      "skipped test with config",
      { input: "test-input", timeout: 5000 },
      async (ctx) => {
        // This test should be skipped, but the config should be properly handled
        expect(ctx.input).toBe("test-input");
      },
    );

    // Test concurrent with metadata and tags
    bt.test.concurrent(
      "concurrent with metadata and tags",
      {
        input: { value: 42 },
        expected: 84,
        metadata: { testType: "math" },
        tags: ["math", "concurrent"],
      },
      async (ctx) => {
        expect(ctx.input).toEqual({ value: 42 });
        expect(ctx.expected).toBe(84);
        expect(ctx.metadata).toEqual({ testType: "math" });
        return (ctx.input as any).value * 2;
      },
    );

    // Test concurrent with scorers
    bt.test.concurrent(
      "concurrent with scorers",
      {
        input: "hello",
        expected: "HELLO",
        scorers: [
          ({ output, expected }) => ({
            name: "uppercase_match",
            score: output === expected ? 1 : 0,
          }),
        ],
      },
      async (ctx) => {
        expect(ctx.input).toBe("hello");
        return (ctx.input as string).toUpperCase();
      },
    );

    // Test concurrent with mixed Braintrust + Vitest options
    bt.test.concurrent(
      "concurrent with mixed options",
      {
        input: { x: 10, y: 20 },
        expected: 30,
        timeout: 3000,
        retry: 1,
      },
      async (ctx) => {
        expect(ctx.input).toEqual({ x: 10, y: 20 });
        expect(ctx.expected).toBe(30);
        return (ctx.input as any).x + (ctx.input as any).y;
      },
    );

    // Test that only modifier works with config (won't run in normal test suite)
    bt.test.skip(
      "only modifier with config (would run if .only)",
      {
        input: "only-test",
        expected: "ONLY-TEST",
        metadata: { modifier: "only" },
      },
      async (ctx) => {
        expect(ctx.input).toBe("only-test");
        expect(ctx.metadata).toEqual({ modifier: "only" });
        return (ctx.input as string).toUpperCase();
      },
    );
  });

  describe("config filtering with modifiers", () => {
    const bt = wrapVitest(
      { test, expect, describe, beforeAll, afterAll },
      { projectName: "filter-test", displaySummary: false },
    );

    // Test that skip modifier properly handles config with mixed Braintrust + Vitest options
    bt.test.skip(
      "config filtering test with skip",
      {
        input: "braintrust-prop",
        expected: "result",
        metadata: { key: "value" },
        tags: ["tag1", "tag2"],
        scorers: [() => ({ name: "test", score: 1 })],
        timeout: 2000,
        retry: 2,
      },
      async (ctx) => {
        // Braintrust properties should be available in context
        expect(ctx.input).toBe("braintrust-prop");
        expect(ctx.expected).toBe("result");
        expect(ctx.metadata).toEqual({ key: "value" });
        // Return value for scorers
        return "result";
      },
    );

    // Test that concurrent modifier properly handles complex configs
    bt.test.concurrent(
      "concurrent filters Braintrust props correctly",
      {
        input: { operation: "multiply", values: [2, 3, 4] },
        expected: 24,
        metadata: { testGroup: "arithmetic" },
        tags: ["math", "multiply"],
        scorers: [
          ({ output, expected }) => ({
            name: "exact_match",
            score: output === expected ? 1 : 0,
          }),
        ],
        timeout: 5000,
      },
      async (ctx) => {
        expect(ctx.input).toEqual({
          operation: "multiply",
          values: [2, 3, 4],
        });
        expect(ctx.expected).toBe(24);
        expect(ctx.metadata).toEqual({ testGroup: "arithmetic" });

        const result = (ctx.input as any).values.reduce(
          (a: number, b: number) => a * b,
          1,
        );
        return result;
      },
    );

    // Test concurrent with only Vitest options (no Braintrust props)
    bt.test.concurrent(
      "concurrent with only Vitest options",
      { timeout: 3000 },
      async () => {
        // Simple test with just Vitest timeout option
        expect(2 + 2).toBe(4);
      },
    );

    // Test concurrent with no config
    bt.test.concurrent("concurrent with no config", async () => {
      // Test without any config object
      expect(true).toBe(true);
    });
  });
});

// Unit tests for configuration and features
describe("Configuration Options", () => {
  // Test logger already set up at module level

  test("supports progress reporting callback", () => {
    const events: any[] = [];
    const bt = wrapVitest(
      { test, expect, describe, beforeAll, afterAll },
      {
        projectName: "test",
        displaySummary: false,
        onProgress: (event) => events.push(event),
      },
    );
    expect(bt).toBeDefined();
    // Progress events will be emitted if onProgress is provided
  });
});

describe("Project selection", () => {
  function makeFakeVitestMethods() {
    const fakeTest: any = vi.fn(
      (_name: string, maybeOptions: any, maybeFn?: any) => {
        const fn = typeof maybeOptions === "function" ? maybeOptions : maybeFn;
        return fn ? fn({}) : undefined;
      },
    );
    fakeTest.skip = fakeTest;
    fakeTest.only = fakeTest;
    fakeTest.concurrent = fakeTest;
    fakeTest.todo = vi.fn();

    const fakeDescribe: any = vi.fn((_name: string, factory: () => void) =>
      factory(),
    );
    fakeDescribe.skip = fakeDescribe;
    fakeDescribe.only = fakeDescribe;
    fakeDescribe.concurrent = fakeDescribe;
    fakeDescribe.todo = vi.fn();

    return {
      test: fakeTest,
      expect,
      describe: fakeDescribe,
      afterAll: vi.fn(),
    };
  }

  beforeEach(() => {
    initExperimentSpy.mockClear();
    _resetContextManager();
  });

  test("wrapVitest passes projectId to initExperiment", async () => {
    const bt = wrapVitest(makeFakeVitestMethods(), {
      projectId: "project-id-123",
      displaySummary: false,
    });

    await bt.describe("project id suite", () => {
      bt.test("uses project id", async () => undefined);
    });

    expect(initExperimentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-id-123",
        experiment: expect.stringMatching(/^project id suite-/),
      }),
    );
  });

  test("wrapVitest uses projectId instead of projectName when both are set", async () => {
    const bt = wrapVitest(makeFakeVitestMethods(), {
      projectName: "project-name",
      projectId: "project-id-123",
      displaySummary: false,
    });

    await bt.describe("precedence suite", () => {
      bt.test("uses project id", async () => undefined);
    });

    expect(initExperimentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-id-123",
      }),
    );
    expect(initExperimentSpy).not.toHaveBeenCalledWith(
      "project-name",
      expect.anything(),
    );
  });

  test("wrapVitest preserves projectName behavior when projectId is absent", async () => {
    const bt = wrapVitest(makeFakeVitestMethods(), {
      projectName: "project-name",
      displaySummary: false,
    });

    await bt.describe("project name suite", () => {
      bt.test("uses project name", async () => undefined);
    });

    expect(initExperimentSpy).toHaveBeenCalledWith(
      "project-name",
      expect.objectContaining({
        experiment: expect.stringMatching(/^project name suite-/),
      }),
    );
  });

  test("wrapVitest preserves suite-name fallback", async () => {
    const bt = wrapVitest(makeFakeVitestMethods(), {
      displaySummary: false,
    });

    await bt.describe("fallback suite", () => {
      bt.test("uses suite name", async () => undefined);
    });

    expect(initExperimentSpy).toHaveBeenCalledWith(
      "fallback suite",
      expect.objectContaining({
        experiment: expect.stringMatching(/^fallback suite-/),
      }),
    );
  });
});

describe("Context Manager", () => {
  test("getExperimentContext returns null when no context is set", () => {
    // Reset context manager to ensure clean state
    _resetContextManager();

    const context = getExperimentContext();
    expect(context).toBeNull();
  });

  test("context manager maintains isolation", () => {
    const manager = getVitestContextManager();
    expect(manager).toBeDefined();
    expect(manager.getCurrentContext()).toBeUndefined();
  });
});

describe("Flush Manager", () => {
  test("flushExperimentWithSync handles null context gracefully", async () => {
    // Should not throw with null context
    await expect(
      flushExperimentWithSync(null, { displaySummary: false }),
    ).resolves.toBeUndefined();
  });
});

describe("Span Parent Relationships", () => {
  const bt = wrapVitest(
    { test, expect, describe, beforeAll, afterAll },
    { projectName: "parent-test", displaySummary: false },
  );

  bt.describe("parent suite", () => {
    bt.test(
      "spans maintain correct parent relationships with traced() - first test",
      async () => {
        const span = bt.getCurrentSpan();
        expect(span).not.toBeNull();
        expect(span?.id).toBeDefined();
      },
    );

    bt.test(
      "spans maintain correct parent relationships with traced() - second test",
      async () => {
        const span = bt.getCurrentSpan();
        expect(span).not.toBeNull();
        expect(span?.id).toBeDefined();
      },
    );
  });

  test("nested describe blocks register tests without errors", () => {
    const registeredTests: string[] = [];

    // Use a mock describe that runs its factory synchronously so we can
    // verify test registration from nested bt.describe calls inside a test body.
    const mockDescribe = vi.fn((_name: string, factory: () => void) => {
      factory();
    }) as any;
    mockDescribe.skip = vi.fn();
    mockDescribe.only = vi.fn();
    mockDescribe.concurrent = vi.fn();

    const mockTest = vi.fn((name: string) => {
      registeredTests.push(name);
    }) as any;
    mockTest.skip = vi.fn();
    mockTest.only = vi.fn();
    mockTest.concurrent = vi.fn();

    const btMock = wrapVitest(
      { test: mockTest, expect, describe: mockDescribe, beforeAll, afterAll },
      { projectName: "nested-test", displaySummary: false },
    );

    btMock.describe("outer suite", () => {
      btMock.test("outer test", () => {});

      btMock.describe("inner suite", () => {
        btMock.test("inner test", () => {});
      });
    });

    expect(registeredTests).toContain("outer test");
    expect(registeredTests).toContain("inner test");
  });
});

describe("Scorer and Dataset Support", () => {
  let bt: BraintrustVitest;

  beforeEach(() => {
    _resetContextManager();
    bt = wrapVitest(
      { test, expect, describe, afterAll },
      { projectName: "feature-tests" },
    );
  });

  test("scorer types are exported", () => {
    // Verify scorer functionality is available
    const testConfig = {
      input: { value: 5 },
      scorers: [
        ({ output }: any) => ({ name: "test", score: output === 10 ? 1 : 0 }),
      ],
    };
    expect(testConfig.scorers).toHaveLength(1);
  });

  test("data field accepts array", () => {
    // Verify data functionality is available
    const testConfig = {
      data: [
        { input: { value: 1 }, expected: 2 },
        { input: { value: 2 }, expected: 4 },
      ],
    };
    expect(testConfig.data).toHaveLength(2);
  });

  test("test config supports scorers and data fields", () => {
    // Type check - this validates the TypeScript types compile correctly
    const config: import("./types").TestConfig = {
      input: { x: 1 },
      expected: 2,
      scorers: [() => 1],
      data: [{ input: {}, expected: {} }],
    };
    expect(config).toBeDefined();
  });
});

describe("wrapExpect", () => {
  let mockSpan: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSpan = { log: vi.fn() };
    vi.spyOn(logger, "currentSpan").mockReturnValue(mockSpan as any);
  });

  describe("unnamed expects pass through unchanged", () => {
    test("unnamed passing assertion does not log to span", () => {
      const wrapped = wrapExpect(expect);
      wrapped(42).toBe(42);
      expect(mockSpan.log).not.toHaveBeenCalled();
    });

    test("unnamed failing assertion does not log to span", () => {
      const wrapped = wrapExpect(expect);
      expect(() => wrapped(1).toBe(2)).toThrow();
      expect(mockSpan.log).not.toHaveBeenCalled();
    });
  });

  describe("named expects log output and scores", () => {
    test("passing assertion logs output and score 1", () => {
      const wrapped = wrapExpect(expect);
      wrapped("hello", "greeting").toBe("hello");

      expect(mockSpan.log).toHaveBeenCalledWith({
        output: { greeting: "hello" },
        scores: { greeting: 1 },
      });
    });

    test("failing assertion logs output and score 0 then re-throws", () => {
      const wrapped = wrapExpect(expect);
      expect(() => wrapped("hello", "greeting").toBe("world")).toThrow();

      expect(mockSpan.log).toHaveBeenCalledWith({
        output: { greeting: "hello" },
        scores: { greeting: 0 },
      });
    });

    test("multiple named expects log independently", () => {
      const wrapped = wrapExpect(expect);
      wrapped(1, "a").toBe(1);
      wrapped("foo", "b").toBe("foo");

      expect(mockSpan.log).toHaveBeenCalledTimes(2);
      expect(mockSpan.log).toHaveBeenCalledWith({
        output: { a: 1 },
        scores: { a: 1 },
      });
      expect(mockSpan.log).toHaveBeenCalledWith({
        output: { b: "foo" },
        scores: { b: 1 },
      });
    });
  });

  describe("chained modifiers", () => {
    test(".not passing logs score 1", () => {
      const wrapped = wrapExpect(expect);
      wrapped(1, "value").not.toBe(2);

      expect(mockSpan.log).toHaveBeenCalledWith({
        output: { value: 1 },
        scores: { value: 1 },
      });
    });

    test(".not failing re-throws and logs score 0", () => {
      const wrapped = wrapExpect(expect);
      expect(() => wrapped(1, "value").not.toBe(1)).toThrow();

      expect(mockSpan.log).toHaveBeenCalledWith({
        output: { value: 1 },
        scores: { value: 0 },
      });
    });
  });

  describe("no active span", () => {
    test("behaves like original expect when no span is available", () => {
      vi.spyOn(logger, "currentSpan").mockReturnValue(null as any);
      const wrapped = wrapExpect(expect);
      wrapped("x", "key").toBe("x");
      expect(mockSpan.log).not.toHaveBeenCalled();
    });

    test("still throws on failing assertion when no span", () => {
      vi.spyOn(logger, "currentSpan").mockReturnValue(null as any);
      const wrapped = wrapExpect(expect);
      expect(() => wrapped("x", "key").toBe("y")).toThrow();
    });
  });

  describe("static methods are preserved", () => {
    test("expect.extend is still accessible", () => {
      const wrapped = wrapExpect(expect);
      expect((wrapped as any).extend).toBe((expect as any).extend);
    });

    test("expect.any is still accessible", () => {
      const wrapped = wrapExpect(expect);
      expect((wrapped as any).any).toBe((expect as any).any);
    });
  });
});

// ✅ STEP 3: Module-level cleanup after all tests complete
afterAll(async () => {
  await _exportsForTestingOnly.clearTestBackgroundLogger();
  await _exportsForTestingOnly.simulateLogoutForTests();
});
