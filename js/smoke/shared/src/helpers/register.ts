/**
 * Test registration and execution helpers
 *
 * This module provides:
 * - register(): Define tests with automatic setup/cleanup fixtures
 * - runTests(): Execute tests and validate coverage
 * - expectFailure(): Wrap tests with expected failure handling
 * - validateCoverage(): Check all registered tests were executed
 */

import type { TestResult, BackgroundLogger } from "./types";
import type { BraintrustModule } from "../suites/import-verification";
import { displayTestResults } from "./display";

const registeredTests = new Set<string>();

export interface TestContext {
  backgroundLogger: BackgroundLogger;
}

export type TestFn = ((braintrust: BraintrustModule) => Promise<TestResult>) & {
  testName: string;
  requiresTestHarness?: boolean;
};

type RegisteredTestFn = (
  braintrust: BraintrustModule,
  ctx: TestContext,
) => Promise<void | string | Partial<TestResult>>;

/**
 * Register a test with automatic setup/cleanup fixtures.
 *
 * The test function receives the braintrust module and a context with backgroundLogger.
 * Tests can:
 * - Return nothing (void) -> pass
 * - Return a string -> pass with message
 * - Return a partial TestResult -> merged with pass status
 * - Throw an error -> fail with error details
 */
export function register(
  name: string,
  fn: RegisteredTestFn,
  { requiresTestHarness = false }: { requiresTestHarness?: boolean } = {},
): TestFn {
  registeredTests.add(name);

  const test = async (braintrust: BraintrustModule): Promise<TestResult> => {
    const testing = braintrust._exportsForTestingOnly as
      | {
          setInitialTestState: () => void;
          simulateLoginForTests: () => Promise<unknown> | unknown;
          simulateLogoutForTests?: () => Promise<unknown> | unknown;
          useTestBackgroundLogger: () => BackgroundLogger;
          clearTestBackgroundLogger: () => void;
        }
      | undefined;

    testing?.setInitialTestState();
    await testing?.simulateLoginForTests();
    const backgroundLogger = testing?.useTestBackgroundLogger();

    try {
      const result = await fn(braintrust, {
        backgroundLogger: backgroundLogger!,
      });

      if (typeof result === "string") {
        return { status: "pass", name, message: result };
      }
      if (result && typeof result === "object") {
        return { status: "pass", name, ...result };
      }
      return { status: "pass", name };
    } catch (error) {
      return {
        status: "fail",
        name,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
    } finally {
      testing?.clearTestBackgroundLogger();
      if (typeof testing?.simulateLogoutForTests === "function") {
        await testing.simulateLogoutForTests();
      }
    }
  };
  test.testName = name;
  test.requiresTestHarness = requiresTestHarness;
  return test;
}

/**
 * Validate that all registered tests were executed.
 * Returns a TestResult indicating coverage status.
 */
export function validateCoverage(results: TestResult[]): TestResult {
  const expected = Array.from(registeredTests);
  const ran = new Set(results.map((r) => r.name));
  const missing = expected.filter((t) => !ran.has(t));

  if (missing.length > 0) {
    return {
      status: "fail",
      name: "test-coverage",
      message: `Missing tests: ${missing.join(", ")}`,
    };
  }
  return {
    status: "pass",
    name: "test-coverage",
    message: `All ${expected.length} registered tests ran`,
  };
}

/**
 * Get all registered test names (useful for debugging).
 */
export function getRegisteredTests(): string[] {
  return Array.from(registeredTests);
}

/**
 * Clear the test registry (useful for testing the test framework itself).
 */
export function clearRegistry(): void {
  registeredTests.clear();
}

export interface RunTestsOptions {
  name: string;
  braintrust: BraintrustModule;
  tests: TestFn[];
  skipCoverage?: boolean;
}

export interface TestRunResults {
  all: TestResult[];
  passed: TestResult[];
  failed: TestResult[];
  xfail: TestResult[];
}

/**
 * Run a set of tests and validate coverage.
 *
 * This function:
 * 1. Executes all provided tests sequentially
 * 2. Validates that all registered tests were run
 * 3. Displays results in standardized format
 * 4. Returns categorized results
 */
export async function runTests({
  name,
  braintrust,
  tests,
  skipCoverage = false,
}: RunTestsOptions): Promise<TestRunResults> {
  const results: TestResult[] = [];
  const testModule: BraintrustModule = {
    ...braintrust,
    __publicModule: braintrust,
  };

  for (const test of tests) {
    if (!testModule._exportsForTestingOnly && test.requiresTestHarness) {
      results.push({
        status: "xfail",
        name: test.testName,
        message: "Requires the private SDK test harness",
      });
    } else {
      results.push(await test(testModule));
    }
  }

  if (!skipCoverage) {
    results.push(validateCoverage(results));
  }

  displayTestResults({ scenarioName: name, results });

  return {
    all: results,
    passed: results.filter((r) => r.status === "pass"),
    failed: results.filter((r) => r.status === "fail"),
    xfail: results.filter((r) => r.status === "xfail"),
  };
}

export type ErrorPredicate = (error: {
  message: string;
  stack?: string;
}) => boolean;

/**
 * Wrap a test to convert expected failures to xfail status.
 *
 * The predicate function receives the error and returns true if the failure
 * is expected. If the predicate throws or returns false, the failure is
 * treated as a real failure (not masked).
 *
 * @param test - The test function to wrap
 * @param predicate - Function that returns true if the error is expected
 * @param reason - Human-readable explanation of why failure is expected
 */
export function expectFailure(
  test: TestFn,
  predicate: ErrorPredicate,
  reason: string,
): TestFn {
  const wrapped = async (braintrust: BraintrustModule): Promise<TestResult> => {
    const result = await test(braintrust);

    if (result.status === "fail" && result.error) {
      try {
        if (predicate(result.error)) {
          return { ...result, status: "xfail", message: reason };
        }
      } catch {
        // Predicate threw - this is unexpected, treat as real failure
      }
    }
    return result;
  };
  wrapped.testName = test.testName;
  wrapped.requiresTestHarness = test.requiresTestHarness;
  return wrapped;
}
