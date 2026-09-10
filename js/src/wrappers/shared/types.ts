import type { OneOrMoreScores } from "../../framework";

// Scorer function type
export type ScorerFunction<Output = unknown> = (args: {
  output: Output;
  expected?: unknown;
  input?: unknown;
  metadata?: Record<string, unknown>;
}) => OneOrMoreScores | Promise<OneOrMoreScores>;

// Progress event types for real-time test reporting
export type ProgressEvent =
  | { type: "suite_start"; suiteName: string }
  | { type: "test_start"; testName: string }
  | {
      type: "test_complete";
      testName: string;
      passed: boolean;
      duration: number;
    }
  | {
      type: "suite_complete";
      suiteName: string;
      passed: number;
      failed: number;
    };
