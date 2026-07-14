export type LangSmithRecord = Record<string, unknown>;

export interface LangSmithAttachmentInfo {
  presigned_url: string;
  mime_type?: string;
}

export interface LangSmithExample {
  id?: string;
  dataset_id?: string;
  inputs: LangSmithRecord;
  outputs?: LangSmithRecord;
  metadata?: LangSmithRecord;
  attachments?: Record<string, LangSmithAttachmentInfo>;
}

export interface LangSmithClient {
  listExamples(options: {
    datasetName: string;
    includeAttachments?: boolean;
  }): AsyncIterable<LangSmithExample>;
}

export type LangSmithEvalData =
  | string
  | LangSmithExample[]
  | AsyncIterable<LangSmithExample>;

export interface LangSmithTargetConfig extends LangSmithRecord {
  attachments?: Record<string, LangSmithAttachmentInfo>;
  callbacks?: unknown;
}

export type LangSmithEvalTarget =
  | ((
      input: LangSmithRecord,
      config?: LangSmithTargetConfig,
    ) => unknown | Promise<unknown>)
  | {
      invoke: (
        input: LangSmithRecord,
        config?: LangSmithTargetConfig,
      ) => unknown | Promise<unknown>;
    };

export interface LangSmithRun {
  id: string;
  name: string;
  run_type: string;
  inputs: LangSmithRecord;
  outputs: LangSmithRecord;
  trace_id: string;
  session_id?: string;
  reference_example_id?: string;
}

export interface LangSmithEvaluationResult {
  key?: string;
  score?: number | boolean | null;
  value?: number | boolean | string | object | null;
  comment?: string;
  correction?: Record<string, unknown>;
  evaluatorInfo?: Record<string, unknown>;
  sourceRunId?: string;
  targetRunId?: string;
  feedbackConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LangSmithEvaluationResults {
  results: LangSmithEvaluationResult[];
}

export interface LangSmithEvaluatorArgs extends LangSmithRun {
  run: LangSmithRun;
  example: LangSmithExample;
  inputs: LangSmithRecord;
  outputs: LangSmithRecord;
  referenceOutputs?: LangSmithRecord;
  attachments?: Record<string, LangSmithAttachmentInfo>;
}

export type LangSmithEvaluator =
  | ((
      args: LangSmithEvaluatorArgs,
      example?: LangSmithExample,
    ) =>
      | LangSmithEvaluationResult
      | LangSmithEvaluationResult[]
      | LangSmithEvaluationResults
      | Promise<
          | LangSmithEvaluationResult
          | LangSmithEvaluationResult[]
          | LangSmithEvaluationResults
        >)
  | {
      evaluateRun: (
        run: LangSmithRun,
        example?: LangSmithExample,
      ) =>
        | LangSmithEvaluationResult
        | LangSmithEvaluationResults
        | Promise<LangSmithEvaluationResult | LangSmithEvaluationResults>;
    };

export interface LangSmithEvaluateOptions {
  data: LangSmithEvalData;
  evaluators?: LangSmithEvaluator[];
  summaryEvaluators?: unknown[];
  metadata?: LangSmithRecord;
  experimentPrefix?: string;
  description?: string;
  maxConcurrency?: number;
  targetConcurrency?: number;
  evaluationConcurrency?: number;
  numRepetitions?: number;
  client?: LangSmithClient;
  includeAttachments?: boolean;
  [key: string]: unknown;
}

export type LangSmithEvaluate<TResult = unknown> = (
  target: LangSmithEvalTarget,
  options: LangSmithEvaluateOptions,
) => Promise<TResult>;

// Accepts overloaded upstream evaluate functions without advertising their
// unsupported comparative overload on the wrapped standard-eval function.
export type LangSmithEvaluateSource<TResult = unknown> = (
  ...args: never[]
) => Promise<TResult>;
