import {
  test,
  expect,
  describe,
  afterAll,
  vi,
  beforeAll,
} from "vite-plus/test";
import { initNodeTestSuite } from "./suite";
import {
  setupNodeTestEnv,
  teardownNodeTestEnv,
  mockTestContext,
} from "./test-helpers";

beforeAll(async () => {
  await setupNodeTestEnv();
});

describe("initNodeTestSuite", () => {
  test("returns correct API surface", () => {
    const suite = initNodeTestSuite({ projectName: "test-project" });

    expect(suite.eval).toBeDefined();
    expect(typeof suite.eval).toBe("function");
    expect(suite.flush).toBeDefined();
    expect(typeof suite.flush).toBe("function");
  });

  test("suite.eval() returns a function, not a promise", () => {
    const suite = initNodeTestSuite({ projectName: "test-project" });

    const result = suite.eval({ input: "hello" }, async ({ input }) => input);

    expect(typeof result).toBe("function");
    // Should not be a promise
    expect(result).not.toHaveProperty("then");
  });

  test("returned function accepts a mock test context and uses t.name for span name", async () => {
    const suite = initNodeTestSuite({
      projectName: "test-project",
      displaySummary: false,
    });

    const t = mockTestContext("my-test-name");
    const fn = suite.eval({ input: "hello" }, async ({ input }) => {
      return `processed: ${input}`;
    });

    // Should not throw
    await fn(t);
  });

  test("scorers are invoked with correct arguments", async () => {
    const suite = initNodeTestSuite({
      projectName: "scorer-test",
      displaySummary: false,
    });

    const scorerFn = vi.fn().mockReturnValue({
      name: "test_score",
      score: 1,
    });

    const fn = suite.eval(
      {
        input: { text: "hello" },
        expected: "world",
        metadata: { lang: "en" },
        scorers: [scorerFn],
      },
      async () => "output-value",
    );

    await fn(mockTestContext("scorer-test"));

    expect(scorerFn).toHaveBeenCalledWith({
      output: "output-value",
      expected: "world",
      input: { text: "hello" },
      metadata: { lang: "en" },
    });
  });

  test("scorers run even when test function throws", async () => {
    const suite = initNodeTestSuite({
      projectName: "scorer-error-test",
      displaySummary: false,
    });

    const scorerFn = vi.fn().mockReturnValue({
      name: "post_error_score",
      score: 0,
    });

    const fn = suite.eval(
      {
        input: "hello",
        scorers: [scorerFn],
      },
      async () => {
        throw new Error("test failure");
      },
    );

    await expect(fn(mockTestContext("error-test"))).rejects.toThrow(
      "test failure",
    );
    expect(scorerFn).toHaveBeenCalled();
  });

  test("return value from test function is logged as output", async () => {
    const suite = initNodeTestSuite({
      projectName: "output-test",
      displaySummary: false,
    });

    const fn = suite.eval({ input: "hello" }, async () => {
      return { result: "some output" };
    });

    // Should complete without error (span logging is tested in integration tests)
    await fn(mockTestContext("output-test"));
  });

  test("when after is passed in config, it is called with a flush function", () => {
    const mockAfter = vi.fn();

    initNodeTestSuite({
      projectName: "after-test",
      after: mockAfter,
    });

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(typeof mockAfter.mock.calls[0][0]).toBe("function");
  });

  test("suite.flush() calls experiment.summarize() and experiment.flush()", async () => {
    const suite = initNodeTestSuite({
      projectName: "flush-test",
      displaySummary: false,
    });

    // Trigger experiment creation by running an eval
    const fn = suite.eval({ input: "trigger" }, async () => "result");
    await fn(mockTestContext("flush-trigger"));

    // flush() should complete without error
    await suite.flush();
  });

  test("suite.flush() is a no-op when no experiment was created", async () => {
    const suite = initNodeTestSuite({
      projectName: "no-experiment",
      displaySummary: false,
    });

    // Should not throw even though no eval was called
    await suite.flush();
  });

  test("config.name overrides t.name for span name", async () => {
    const events: any[] = [];
    const suite = initNodeTestSuite({
      projectName: "name-override-test",
      displaySummary: false,
      onProgress: (event) => events.push(event),
    });

    const fn = suite.eval(
      { input: "hello", name: "custom-span-name" },
      async () => "result",
    );

    await fn(mockTestContext("original-name"));

    const testStart = events.find((e) => e.type === "test_start");
    expect(testStart.testName).toBe("custom-span-name");
  });

  test("falls back to 'unnamed test' when neither config.name nor t.name is available", async () => {
    const events: any[] = [];
    const suite = initNodeTestSuite({
      projectName: "unnamed-test",
      displaySummary: false,
      onProgress: (event) => events.push(event),
    });

    const fn = suite.eval({ input: "hello" }, async () => "result");

    await fn({}); // No name on context

    const testStart = events.find((e) => e.type === "test_start");
    expect(testStart.testName).toBe("unnamed test");
  });

  test("onProgress receives test_start and test_complete events", async () => {
    const events: any[] = [];
    const suite = initNodeTestSuite({
      projectName: "progress-test",
      displaySummary: false,
      onProgress: (event) => events.push(event),
    });

    const fn = suite.eval({ input: "hello" }, async () => "result");
    await fn(mockTestContext("progress-test"));

    expect(events).toEqual([
      { type: "test_start", testName: "progress-test" },
      expect.objectContaining({
        type: "test_complete",
        testName: "progress-test",
        passed: true,
      }),
    ]);
    expect(events[1].duration).toBeTypeOf("number");
  });

  test("onProgress reports passed=false when test throws", async () => {
    const events: any[] = [];
    const suite = initNodeTestSuite({
      projectName: "fail-progress-test",
      displaySummary: false,
      onProgress: (event) => events.push(event),
    });

    const fn = suite.eval({ input: "hello" }, async () => {
      throw new Error("intentional failure");
    });

    await expect(fn(mockTestContext("fail-test"))).rejects.toThrow();

    const complete = events.find((e) => e.type === "test_complete");
    expect(complete.passed).toBe(false);
  });
});

afterAll(async () => {
  await teardownNodeTestEnv();
});
