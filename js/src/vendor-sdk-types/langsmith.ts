export type LangSmithRunEvent = {
  name?: unknown;
  time?: unknown;
};

export type LangSmithRun = {
  id?: unknown;
  name?: unknown;
  run_type?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  error?: unknown;
  extra?: unknown;
  tags?: unknown;
  events?: LangSmithRunEvent[];
  serialized?: unknown;
  parent_run_id?: unknown;
  parent_run?: LangSmithRun;
  trace_id?: unknown;
  dotted_order?: unknown;
};

export type LangSmithBatchIngestRuns = {
  runCreates?: LangSmithRun[];
  runUpdates?: LangSmithRun[];
};

export type LangSmithClient = {
  createRun?: (run: LangSmithRun, options?: unknown) => Promise<unknown>;
  updateRun?: (
    runId: string,
    run: LangSmithRun,
    options?: unknown,
  ) => Promise<unknown>;
  batchIngestRuns?: (
    runs: LangSmithBatchIngestRuns,
    options?: unknown,
  ) => Promise<unknown>;
};

export type LangSmithClientConstructor = new (
  ...args: unknown[]
) => LangSmithClient;

export type LangSmithClientModule = {
  Client: LangSmithClientConstructor;
};

export type LangSmithRunTree = LangSmithRun & {
  createChild?: (config: unknown) => LangSmithRunTree;
  postRun?: (excludeChildRuns?: boolean) => Promise<unknown>;
  patchRun?: (options?: unknown) => Promise<unknown>;
};

export type LangSmithRunTreeConstructor = new (
  ...args: unknown[]
) => LangSmithRunTree;

export type LangSmithRunTreesModule = {
  RunTree: LangSmithRunTreeConstructor;
};

export type LangSmithTraceableConfig = {
  on_end?: (runTree?: LangSmithRunTree) => void;
  [key: string]: unknown;
};

export type LangSmithTraceable = (
  fn: (...args: never[]) => unknown,
  config?: LangSmithTraceableConfig,
) => (...args: never[]) => unknown;

export type LangSmithTraceableModule = {
  traceable: LangSmithTraceable;
};
