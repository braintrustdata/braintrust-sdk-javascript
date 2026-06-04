import type { EvaluatorDef, EvalResultWithSummary } from "../framework";

export interface ProgressReporter {
  start: (name: string, total: number) => void;
  stop: () => void;
  increment: (name: string) => void;
  setTotal?: (name: string, total: number) => void;
}

export interface ReporterOpts {
  verbose: boolean;
  jsonl: boolean;
}

export interface ReporterBody<EvalReport> {
  /**
   * A function that takes an evaluator and its result and returns a report.
   *
   * @param evaluator
   * @param result
   * @param opts
   */
  reportEval(
    // These any's are required because these function specifications don't know
    // or need to know the types of the input/output/etc for the evaluator.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluator: EvaluatorDef<any, any, any, any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: EvalResultWithSummary<any, any, any, any>,
    opts: ReporterOpts,
  ): Promise<EvalReport> | EvalReport;

  /**
   * A function that takes all evaluator results and returns a boolean indicating
   * whether the run was successful. If you return false, the `braintrust eval`
   * command will exit with a non-zero status code.
   *
   * @param reports
   */
  reportRun(reports: EvalReport[]): boolean | Promise<boolean>;
}

export type ReporterDef<EvalReport> = {
  name: string;
} & ReporterBody<EvalReport>;
