import type { Span } from "../../logger";

// Re-export from shared
export type { ScorerFunction, ProgressEvent } from "../shared/types";
import type { ScorerFunction, ProgressEvent } from "../shared/types";

// Braintrust-specific test config properties
export interface BraintrustTestConfig {
  input?: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  scorers?: ScorerFunction[];
  data?: Array<{
    input?: unknown;
    expected?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }>;
}

// Combined config that supports Braintrust options plus any other vitest properties
export interface TestConfig extends BraintrustTestConfig {
  // Allow any additional properties Vitest might accept (timeout, retry, fails, etc.)
  [key: string]: unknown;
}

// Add test modifiers (skip, only, concurrent, todo)
type WithModifiers<T> = T & {
  skip: T;
  only: T;
  concurrent: T;
  todo: (name: string) => void;
};

export type TestContext = Pick<
  BraintrustTestConfig,
  "input" | "expected" | "metadata"
>;

export type BaseTestFunction<VitestContext = unknown> = {
  (name: string, fn: (context: VitestContext) => void | Promise<void>): void;
  each?: <T>(
    cases: readonly T[],
  ) => (name: string, fn: (context: T) => void | Promise<void>) => void;
};

export type TestFunction<VitestContext = unknown> = WithModifiers<
  BaseTestFunction<VitestContext>
>;

export type BaseDescribeFunction = {
  (name: string, factory: () => void): void;
  each?: <T>(
    cases: readonly T[],
  ) => (name: string, factory: () => void) => void;
};

export type DescribeFunction = WithModifiers<BaseDescribeFunction>;

interface BaseWrappedTest<VitestContext = unknown> {
  (
    name: string,
    fn: (context: VitestContext) => unknown | Promise<unknown>,
  ): void;
  (
    name: string,
    config: TestConfig,
    fn: (context: TestContext & VitestContext) => unknown | Promise<unknown>,
  ): void;
  each: <T>(
    cases: readonly T[],
  ) => (
    name: string,
    fn: (
      context: T & TestContext & VitestContext,
    ) => unknown | Promise<unknown>,
  ) => void;
}

export type WrappedTest<VitestContext = unknown> = WithModifiers<
  BaseWrappedTest<VitestContext>
>;

interface BaseWrappedDescribe {
  (name: string, factory: () => void): void;
  each: <T>(cases: readonly T[]) => (name: string, factory: () => void) => void;
}

export type WrappedDescribe = WithModifiers<BaseWrappedDescribe>;

export interface VitestMethods<
  VitestContext = unknown,
  ExpectType extends (...args: unknown[]) => unknown = (
    ...args: unknown[]
  ) => unknown,
> {
  test: TestFunction<VitestContext>;
  it?: TestFunction<VitestContext>;
  expect: ExpectType;
  describe: DescribeFunction;
  beforeAll?: (fn: () => void | Promise<void>) => void;
  afterAll?: (fn: () => void | Promise<void>) => void;
  beforeEach?: (fn: (context: VitestContext) => void | Promise<void>) => void;
  afterEach?: (fn: (context: VitestContext) => void | Promise<void>) => void;
}

export interface DatasetOptions {
  project: string;
  dataset: string;
  version?: string;
  description?: string;
}

export interface DatasetRecord {
  id: string;
  input: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface BraintrustVitest<
  VitestContext = unknown,
  ExpectType extends (...args: unknown[]) => unknown = (
    ...args: unknown[]
  ) => unknown,
> {
  test: WrappedTest<VitestContext>;
  it: WrappedTest<VitestContext>;
  expect: ExpectType;
  describe: WrappedDescribe;
  beforeAll: (fn: () => void | Promise<void>) => void;
  afterAll: (fn: () => void | Promise<void>) => void;
  beforeEach?: (fn: (context: VitestContext) => void | Promise<void>) => void;
  afterEach?: (fn: (context: VitestContext) => void | Promise<void>) => void;
  logOutputs: (outputs: Record<string, unknown>) => void;
  logFeedback: (feedback: {
    name: string;
    score: number;
    metadata?: Record<string, unknown>;
  }) => void;
  getCurrentSpan: () => Span | null;
  /**
   * Helper function to flush the experiment and optionally display a summary.
   * Use this in afterAll() instead of manually calling getExperimentContext().
   *
   * @param options - Optional configuration
   * @param options.displaySummary - Whether to display the experiment summary (defaults to true)
   */
  flushExperiment: (options?: { displaySummary?: boolean }) => Promise<void>;
}

export interface WrapperConfig {
  projectName?: string;
  /**
   * The id of the project to create experiments in. Takes precedence over
   * `projectName` if both are set.
   */
  projectId?: string;
  /**
   * If true, displays a formatted experiment summary with scores and URL after the test suite completes.
   * Defaults to true. Set to false to suppress the summary output.
   */
  displaySummary?: boolean;
  /**
   * Callback for real-time progress events.
   * Called when tests start, complete, or progress updates occur.
   * Progress reporting is always enabled when this callback is provided.
   */
  onProgress?: (event: ProgressEvent) => void;
}
