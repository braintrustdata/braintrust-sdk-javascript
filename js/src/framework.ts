import {
  makeScorerPropagatedEvent,
  mergeDicts,
  Score,
  SpanComponentsV3,
  SpanTypeAttribute,
  spanObjectTypeV3ToTypedString,
} from "../util/index";
import {
  type GitMetadataSettingsType as GitMetadataSettings,
  type ObjectReferenceType as ObjectReference,
  type RepoInfoType as RepoInfo,
  type SSEProgressEventDataType as SSEProgressEventData,
} from "./generated_types";
import { queue } from "async";

import iso from "./isomorph";
import { debugLogger } from "./debug-logger";
import { GenericFunction } from "./framework-types";
import { CodeFunction, CodePrompt, CodeParameters } from "./framework2";
import { Trace, LocalTrace } from "./trace";
import {
  BaseMetadata,
  BraintrustState,
  Dataset,
  DefaultMetadataType,
  EvalCase,
  Experiment,
  ExperimentSummary,
  FullInitOptions,
  NOOP_SPAN,
  type ParametersRef,
  RemoteEvalParameters,
  Span,
  StartSpanArgs,
  init as _initExperiment,
  currentSpan,
  flush,
  logError as logSpanError,
  startSpan,
  traced,
  withCurrent,
  withParent,
  _internalGetGlobalState,
} from "./logger";
import type { ProgressReporter } from "./reporters/types";
import { SimpleProgressReporter } from "./reporters/progress";
import type {
  ReporterOpts,
  ReporterBody,
  ReporterDef,
} from "./reporters/types";
import { isEmpty, InternalAbortError } from "./util";
import {
  EvalParameters,
  InferParameters,
  validateParameters,
} from "./eval-parameters";

export type BaseExperiment<
  Input,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
> = {
  _type: "BaseExperiment";
  _phantom?: [Input, Expected, Metadata];
  name?: string;
};

/**
 * Use this to specify that the dataset should actually be the data from a previous (base) experiment.
 * If you do not specify a name, Braintrust will automatically figure out the best base experiment to
 * use based on your git history (or fall back to timestamps).
 *
 * @param options
 * @param options.name The name of the base experiment to use. If unspecified, Braintrust will automatically figure out the best base
 * using your git history (or fall back to timestamps).
 * @returns
 */
export function BaseExperiment<
  Input = unknown,
  Expected = unknown,
  Metadata extends BaseMetadata = DefaultMetadataType,
>(
  options: {
    name?: string;
  } = {},
): BaseExperiment<Input, Expected, Metadata> {
  return { _type: "BaseExperiment", ...options };
}

export type EvalData<
  Input,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
> =
  | EvalCase<Input, Expected, Metadata>[]
  | (() => EvalCase<Input, Expected, Metadata>[])
  | Promise<EvalCase<Input, Expected, Metadata>[]>
  | (() => Promise<EvalCase<Input, Expected, Metadata>[]>)
  | AsyncGenerator<EvalCase<Input, Expected, Metadata>>
  | AsyncIterable<EvalCase<Input, Expected, Metadata>>
  | BaseExperiment<Input, Expected, Metadata>
  | (() => BaseExperiment<Input, Expected, Metadata>);

export type EvalTask<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
> =
  | ((
      input: Input,
      hooks: EvalHooks<Expected, Metadata, Parameters>,
    ) => Promise<Output>)
  | ((
      input: Input,
      hooks: EvalHooks<Expected, Metadata, Parameters>,
    ) => Output);

export type TaskProgressEvent = Omit<
  SSEProgressEventData,
  "id" | "origin" | "object_type" | "name"
>;

export interface EvalHooks<
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
> {
  /**
   * @deprecated Use `metadata` instead.
   */
  meta: (info: Metadata) => void;
  /**
   * The metadata object for the current evaluation. You can mutate this object to add or remove metadata.
   */
  metadata: Metadata extends void ? Record<string, unknown> : Metadata;
  /**
   * The expected output for the current evaluation.
   */
  expected: Expected;
  /**
   * The task's span.
   */
  span: Span;
  /**
   * The current parameters being used for this specific task execution.
   * Array parameters are converted to single values.
   */
  parameters: InferParameters<Parameters>;
  /**
   * Report progress that will show up in the playground.
   */
  reportProgress: (progress: TaskProgressEvent) => void;
  /**
   * The index of the current trial (0-based). This is useful when trialCount > 1.
   */
  trialIndex: number;
  /**
   * The tags for the current evaluation.
   */
  tags: string[] | undefined;
}

// This happens to be compatible with ScorerArgs defined in "../util".
export type EvalScorerArgs<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
> = EvalCase<Input, Expected, Metadata> & {
  output: Output;
  trace?: Trace;
};

export type OneOrMoreScores = Score | number | null | Array<Score>;

export type EvalScorer<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
> = (
  args: EvalScorerArgs<Input, Output, Expected, Metadata>,
) => OneOrMoreScores | Promise<OneOrMoreScores>;

export type EvalResult<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
> = EvalCase<Input, Expected, Metadata> & {
  output: Output;
  scores: Record<string, number | null>;
  error: unknown;
  origin?: ObjectReference;
};

type ErrorScoreHandler = (args: {
  rootSpan: Span;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: EvalCase<any, any, any>;
  unhandledScores: string[];
}) => Record<string, number> | undefined | void;

export interface Evaluator<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> {
  /**
   * A function that returns a list of inputs, expected outputs, and metadata.
   */
  data: EvalData<Input, Expected, Metadata>;

  /**
   * A function that takes an input and returns an output.
   */
  task: EvalTask<Input, Output, Expected, Metadata, Parameters>;

  /**
   * A set of functions that take an input, output, and expected value and return a score.
   */
  scores: EvalScorer<Input, Output, Expected, Metadata>[];

  /**
   * A set of parameters that will be passed to the evaluator.
   * Can be:
   * - A raw EvalParameters schema (Zod schemas)
   * - A Parameters instance from loadParameters()
   * - A Promise<Parameters> from loadParameters()
   */
  parameters?:
    | Parameters
    | RemoteEvalParameters<boolean, boolean, InferParameters<Parameters>>
    | Promise<
        RemoteEvalParameters<boolean, boolean, InferParameters<Parameters>>
      >;

  /**
   * An optional name for the experiment.
   */
  experimentName?: string;

  /**
   * An optional description for the experiment.
   */
  description?: string;

  /**
   * The number of times to run the evaluator per input. This is useful for evaluating applications that
   * have non-deterministic behavior and gives you both a stronger aggregate measure and a sense of the
   * variance in the results.
   */
  trialCount?: number;

  /**
   * Optional additional metadata for the experiment.
   */
  metadata?: Record<string, unknown>;

  /**
   * Optional tags for the experiment.
   */
  tags?: string[];

  /**
   * Whether the experiment should be public. Defaults to false.
   */
  isPublic?: boolean;

  /**
   * Whether to update an existing experiment with `experiment_name` if one exists. Defaults to false.
   */
  update?: boolean;

  /**
   * The duration, in milliseconds, after which to time out the evaluation.
   * Defaults to undefined, in which case there is no timeout.
   */
  timeout?: number;

  /**
   * An abort signal that can be used to stop the evaluation.
   */
  signal?: AbortSignal;

  /**
   * The maximum number of tasks/scorers that will be run concurrently.
   * Defaults to undefined, in which case there is no max concurrency.
   */
  maxConcurrency?: number;

  /**
   * If specified, uses the given project ID instead of the evaluator's name to identify the project.
   */
  projectId?: string;

  /**
   * If specified, uses the logger state to initialize Braintrust objects. If unspecified, falls back
   * to the global state (initialized using your API key).
   */
  state?: BraintrustState;

  /**
   * An optional experiment name to use as a base. If specified, the new experiment will be summarized
   * and compared to this experiment.
   */
  baseExperimentName?: string;

  /**
   * An optional experiment id to use as a base. If specified, the new experiment will be summarized
   * and compared to this experiment. This takes precedence over `baseExperimentName` if specified.
   */
  baseExperimentId?: string;

  /**
   * Optional settings for collecting git metadata. By default, will collect all git metadata fields allowed in org-level settings.
   */
  gitMetadataSettings?: GitMetadataSettings;

  /**
   * Optionally explicitly specify the git metadata for this experiment. This takes precedence over `gitMetadataSettings` if specified.
   */
  repoInfo?: RepoInfo;

  /**
   * Optionally supply a custom function to specifically handle score values when tasks or scoring functions have errored.
   * A default implementation is exported as `defaultErrorScoreHandler` which will log a 0 score to the root span for any scorer that was not run.
   */
  errorScoreHandler?: ErrorScoreHandler;

  /**
   * Whether to summarize the scores of the experiment after it has run.
   * Defaults to true.
   */
  summarizeScores?: boolean;

  /**
   * Flushes spans before calling scoring functions
   */
  flushBeforeScoring?: boolean;
}

export class EvalResultWithSummary<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
> {
  constructor(
    public summary: ExperimentSummary,
    public results: EvalResult<Input, Output, Expected, Metadata>[],
  ) {}

  /**
   * @deprecated Use `summary` instead.
   */
  toString(): string {
    return JSON.stringify(this.summary);
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `EvalResultWithSummary(summary="...", results=[...])`;
  }

  toJSON(): {
    summary: ExperimentSummary;
    results: EvalResult<Input, Output, Expected, Metadata>[];
  } {
    return {
      summary: this.summary,
      results: this.results,
    };
  }
}

export type {
  ReporterOpts,
  ReporterBody,
  ReporterDef,
} from "./reporters/types";

function makeEvalName(projectName: string, experimentName?: string) {
  let out = projectName;
  if (experimentName) {
    out += ` [experimentName=${experimentName}]`;
  }
  return out;
}

export type EvaluatorDef<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> = {
  projectName: string;
  evalName: string;
} & Evaluator<Input, Output, Expected, Metadata, Parameters>;

export type EvaluatorFile = {
  functions: CodeFunction<
    unknown,
    unknown,
    GenericFunction<unknown, unknown>
  >[];
  prompts: CodePrompt[];
  parameters?: CodeParameters[];
  evaluators: {
    [evalName: string]: {
      evaluator: EvaluatorDef<
        unknown,
        unknown,
        unknown,
        BaseMetadata,
        EvalParameters
      >;
      reporter?: ReporterDef<unknown> | string;
    };
  };
  reporters: { [reporterName: string]: ReporterDef<unknown> };
};

function initExperiment<IsOpen extends boolean = false>(
  state: BraintrustState | undefined,
  options: Readonly<FullInitOptions<IsOpen>> = {},
) {
  return _initExperiment({
    state,
    ...options,
    setCurrent: false,
  });
}

async function getExperimentParametersRef(
  parameters:
    | EvalParameters
    | RemoteEvalParameters<boolean, boolean>
    | Promise<RemoteEvalParameters<boolean, boolean>>
    | undefined,
): Promise<ParametersRef | undefined> {
  if (!parameters) {
    return undefined;
  }

  const resolvedParameters =
    parameters instanceof Promise ? await parameters : parameters;

  if (!RemoteEvalParameters.isParameters(resolvedParameters)) {
    return undefined;
  }

  if (resolvedParameters.id === undefined) {
    return undefined;
  }

  return {
    id: resolvedParameters.id,
    version: resolvedParameters.version,
  };
}

export function callEvaluatorData<
  Input,
  Expected,
  Metadata extends BaseMetadata = DefaultMetadataType,
>(
  data: EvalData<Input, Expected, Metadata>,
): {
  data: EvalData<Input, Expected, Metadata>;
  baseExperiment: string | undefined;
} {
  const dataResult = typeof data === "function" ? data() : data;

  let baseExperiment: string | undefined = undefined;
  if ("_type" in dataResult && dataResult._type === "BaseExperiment") {
    baseExperiment = dataResult.name;
  }

  return {
    data: dataResult,
    baseExperiment,
  };
}

export type SpanContext = {
  currentSpan: typeof currentSpan;
  startSpan: typeof startSpan;
  withCurrent: typeof withCurrent;
  NOOP_SPAN: typeof NOOP_SPAN;
};

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function isIterable<T>(value: unknown): value is Iterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function"
  );
}

declare global {
  var _evals: EvaluatorFile;

  var _spanContext: SpanContext | undefined;

  var _lazy_load: boolean;
}

globalThis._evals = {
  functions: [],
  prompts: [],
  parameters: [],
  evaluators: {},
  reporters: {},
};

export interface EvalOptions<EvalReport, Parameters extends EvalParameters> {
  /**
   * A `Reporter` which you can use to summarize progress after an Eval() runs.
   */
  reporter?: ReporterDef<EvalReport> | string;
  /**
   * Do not send logs to Braintrust. When true, the evaluation runs locally
   * and builds a local summary instead of creating an experiment. Defaults to false.
   */
  noSendLogs?: boolean;
  /**
   * A callback function that will be called when an experiment is started with
   * information about its project, experiment id, name, and other useful information.
   * @param metadata
   */
  onStart?: (metadata: Omit<ExperimentSummary, "scores" | "metrics">) => void;
  /**
   * A function that will be called with progress events, which can be used to
   * display intermediate progress.
   *
   * @param data
   */
  stream?: (data: SSEProgressEventData) => void;
  /**
   * If specified, instead of creating a new experiment object, the Eval() will populate
   * the object or span specified by this parent.
   */
  parent?: string;
  /**
   * Specify this to create a custom progress-bar style reporter. Note that this interface
   * is somewhat outdated, and may be removed in the future.
   */
  progress?: ProgressReporter;
  /**
   * The parameters to use for the evaluator.
   */
  parameters?: InferParameters<Parameters>;
  /**
   * Whether to retain the per-example Eval results and return them from Eval().
   *
   * When `true` (default): All evaluation results are collected in memory and returned,
   * allowing inspection of individual test case inputs, outputs, scores, and metadata.
   * This is convenient for interactive analysis but can consume significant memory for
   * large datasets (e.g., millions of examples).
   *
   * When `false`: Individual results are not retained in memory. Only aggregate score
   * statistics are computed incrementally. The returned `results` array will be empty,
   * but the `summary` will still contain accurate score aggregates. This is suitable for:
   * - Large-scale evaluations (millions of examples)
   * - Memory-constrained environments
   * - Scenarios where only aggregate metrics are needed
   *
   * Note: When `false`, you cannot access individual test case results after evaluation.
   * If you need to inspect specific failures or outputs, keep this as `true`.
   *
   * Defaults to `true` for backwards compatibility.
   *
   * @example
   * // Memory-efficient evaluation of a large dataset
   * await Eval("large-eval", evaluator, {
   *   returnResults: false  // Only keep aggregate scores
   * });
   */
  returnResults?: boolean;
  /**
   * Whether to enable the span cache for this evaluation. The span cache stores span data on disk
   * to minimize memory usage and allow scorers to read spans without server round-trips. Defaults to true.
   * Set to false to disable caching if you are doing distributed evaluation or want to reduce disk I/O.
   *
   * @example
   * // Disable span cache
   * await Eval("my-eval", evaluator, {
   *   enableCache: false
   * });
   */
  enableCache?: boolean;
}

export function _initializeSpanContext() {
  // This only needs to be set once, but Eval(), Task(), etc. are the only time
  // we get to run code while importing a module, so use it to
  // grab these values.
  globalThis._spanContext = { currentSpan, withCurrent, startSpan, NOOP_SPAN };
}

export async function Eval<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  EvalReport = boolean,
  Parameters extends EvalParameters = EvalParameters,
>(
  name: string,
  evaluator: Evaluator<Input, Output, Expected, Metadata, Parameters>,
  reporterOrOpts?:
    | ReporterDef<EvalReport>
    | string
    | EvalOptions<EvalReport, Parameters>,
): Promise<EvalResultWithSummary<Input, Output, Expected, Metadata>> {
  const options: EvalOptions<EvalReport, Parameters> = isEmpty(reporterOrOpts)
    ? {}
    : typeof reporterOrOpts === "string"
      ? { reporter: reporterOrOpts }
      : "name" in reporterOrOpts
        ? { reporter: reporterOrOpts }
        : reporterOrOpts;

  let evalName = makeEvalName(name, evaluator.experimentName);
  if (globalThis._evals.evaluators[evalName]) {
    evalName = `${evalName}_${Object.keys(_evals).length}`;
  }
  if (globalThis._lazy_load) {
    globalThis._evals.evaluators[evalName] = {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      evaluator: {
        evalName,
        projectName: name,
        ...evaluator,
      } as EvaluatorDef<
        unknown,
        unknown,
        unknown,
        BaseMetadata,
        EvalParameters
      >,
      reporter: options.reporter,
    };

    _initializeSpanContext();

    // Better to return this empty object than have an annoying-to-use signature
    return new EvalResultWithSummary(
      {
        scores: {},
        metrics: {},
        projectName: "",
        experimentName: "",
      },
      [],
    );
  }

  const progressReporter = options.progress ?? new SimpleProgressReporter();
  const shouldCollectResults = options.returnResults ?? true;

  if (typeof options.reporter === "string") {
    throw new Error(
      "Must specify a reporter object, not a name. Can only specify reporter names when running 'braintrust eval'",
    );
  }

  const resolvedReporter = options.reporter || defaultReporter;
  try {
    const { data, baseExperiment: defaultBaseExperiment } = callEvaluatorData(
      evaluator.data,
    );
    const parameters = await getExperimentParametersRef(evaluator.parameters);
    // NOTE: This code is duplicated with initExperiment in js/src/cli.ts. Make sure
    // to update that if you change this.
    const experiment =
      options.parent || options.noSendLogs
        ? null
        : initExperiment(evaluator.state, {
            ...(evaluator.projectId
              ? { projectId: evaluator.projectId }
              : { project: name }),
            experiment: evaluator.experimentName,
            description: evaluator.description,
            metadata: evaluator.metadata,
            tags: evaluator.tags,
            isPublic: evaluator.isPublic,
            update: evaluator.update,
            baseExperiment:
              evaluator.baseExperimentName ?? defaultBaseExperiment,
            baseExperimentId: evaluator.baseExperimentId,
            gitMetadataSettings: evaluator.gitMetadataSettings,
            repoInfo: evaluator.repoInfo,
            dataset: Dataset.isDataset(data) ? data : undefined,
            parameters,
          });

    // Ensure experiment ID is resolved before tasks start for OTEL parent attribute support
    // The Experiment constructor starts resolution (fire-and-forget), but we await here to ensure completion
    // Only needed when OTEL compat mode is enabled
    if (
      experiment &&
      typeof process !== "undefined" &&
      globalThis.BRAINTRUST_CONTEXT_MANAGER !== undefined
    ) {
      await experiment._waitForId();
    }

    if (experiment && options.onStart) {
      const summary = await experiment.summarize({ summarizeScores: false });
      options.onStart(summary);
    }

    try {
      const evalDef = {
        evalName,
        projectName: name,
        ...evaluator,
        data,
      };
      const enableCache = options.enableCache ?? true;
      let ret;
      if (options.parent) {
        ret = await withParent(
          options.parent,
          () =>
            runEvaluator(
              null,
              evalDef,
              progressReporter,
              [],
              options.stream,
              options.parameters,
              shouldCollectResults,
              enableCache,
            ),
          evaluator.state,
        );
      } else {
        ret = await runEvaluator(
          experiment,
          evalDef,
          progressReporter,
          [],
          options.stream,
          options.parameters,
          shouldCollectResults,
          enableCache,
        );
      }
      progressReporter.stop();
      resolvedReporter.reportEval(evalDef, ret, {
        verbose: true,
        jsonl: false,
      });
      return ret;
    } finally {
      if (experiment) {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        await experiment.flush().catch(console.error);
      } else if (options.parent) {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        await flush({ state: evaluator.state }).catch(console.error);
      }
    }
  } finally {
    progressReporter.stop();
  }
}

export function Reporter<EvalReport>(
  name: string,
  reporter: ReporterBody<EvalReport>,
): ReporterDef<EvalReport> {
  const ret = { name, ...reporter };
  if (_evals.reporters[name]) {
    throw new Error(`Reporter ${name} already exists`);
  }

  if (globalThis._lazy_load) {
    _evals.reporters[name] = ret;
  }

  return ret;
}

export interface Filter {
  path: string[];
  pattern: RegExp;
}

function serializeJSONWithPlainString(v: unknown) {
  if (typeof v === "string") {
    return v;
  } else {
    return JSON.stringify(v);
  }
}

function deserializePlainStringAsJSON(s: string) {
  try {
    return { value: JSON.parse(s), error: undefined };
  } catch (e) {
    return { value: s, error: e };
  }
}

export function parseFilters(filters: string[]): Filter[] {
  const result: Filter[] = [];
  for (const f of filters) {
    const equalsIdx = f.indexOf("=");
    if (equalsIdx === -1) {
      throw new Error(`Invalid filter ${f}`);
    }
    const [path, value] = [f.slice(0, equalsIdx), f.slice(equalsIdx + 1)];
    let deserializedValue = deserializePlainStringAsJSON(value).value;
    if (typeof deserializedValue !== "string") {
      deserializedValue = value; // Just fall back to the original input
    }
    result.push({
      path: path.split("."),
      pattern: new RegExp(deserializedValue),
    });
  }
  return result;
}

function evaluateFilter(object: unknown, filter: Filter) {
  const { path, pattern } = filter;
  const key = path.reduce(
    (acc, p) =>
      typeof acc === "object" && acc !== null
        ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          (acc as Record<string, unknown>)[p]
        : undefined,
    object,
  );
  if (key === undefined) {
    return false;
  }
  return pattern.test(serializeJSONWithPlainString(key));
}

export function scorerName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scorer: EvalScorer<any, any, any, any>,
  scorer_idx: number,
) {
  return scorer.name || `scorer_${scorer_idx}`;
}

export async function runEvaluator(
  experiment: Experiment | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator: EvaluatorDef<any, any, any, any, any>,
  progressReporter: ProgressReporter,
  filters: Filter[],
  stream: ((data: SSEProgressEventData) => void) | undefined,
  parameters?: InferParameters<EvalParameters>,
  collectResults = true,
  enableCache = true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<EvalResultWithSummary<any, any, any, any>> {
  return await runEvaluatorInternal(
    experiment,
    evaluator,
    progressReporter,
    filters,
    stream,
    parameters,
    collectResults,
    enableCache,
  );
}

export const defaultErrorScoreHandler: ErrorScoreHandler = ({
  rootSpan,
  data: _,
  unhandledScores,
}) => {
  const scores = Object.fromEntries(unhandledScores.map((s) => [s, 0]));
  rootSpan.log({ scores });
  return scores;
};

async function runEvaluatorInternal(
  experiment: Experiment | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator: EvaluatorDef<any, any, any, any>,
  progressReporter: ProgressReporter,
  filters: Filter[],
  stream: ((data: SSEProgressEventData) => void) | undefined,
  parameters: InferParameters<EvalParameters> | undefined,
  collectResults: boolean,
  enableCache: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<EvalResultWithSummary<any, any, any, any>> {
  // Start span cache for this eval (it's disabled by default to avoid temp files outside of evals)
  // Only start if enableCache is true (default)
  if (enableCache) {
    (evaluator.state ?? _internalGetGlobalState())?.spanCache?.start();
  }
  try {
    if (typeof evaluator.data === "string") {
      throw new Error("Unimplemented: string data paths");
    }
    let dataResult =
      typeof evaluator.data === "function" ? evaluator.data() : evaluator.data;

    parameters = await validateParameters(
      parameters ?? {},
      evaluator.parameters,
    );

    if ("_type" in dataResult) {
      if (dataResult._type !== "BaseExperiment") {
        // For some reason, the typesystem won't let me check if dataResult._type === "BaseExperiment"
        throw new Error("Invalid _type");
      }
      if (!experiment) {
        throw new Error(
          "Cannot use BaseExperiment() without connecting to Braintrust (you most likely set --no-send-logs)",
        );
      }
      let name = dataResult.name;
      if (isEmpty(name)) {
        const baseExperiment = await experiment.fetchBaseExperiment();
        if (!baseExperiment) {
          throw new Error("BaseExperiment() failed to fetch base experiment");
        }
        name = baseExperiment.name;
      }

      dataResult = initExperiment(evaluator.state, {
        ...(evaluator.projectId
          ? { projectId: evaluator.projectId }
          : { project: evaluator.projectName }),
        experiment: name,
        open: true,
      }).asDataset();
    }

    const resolvedDataResult =
      dataResult instanceof Promise ? await dataResult : dataResult;

    const dataIterable: AsyncIterable<EvalCase<any, any, any>> = (() => {
      if (isAsyncIterable<EvalCase<any, any, any>>(resolvedDataResult)) {
        return resolvedDataResult;
      }
      if (
        Array.isArray(resolvedDataResult) ||
        isIterable<EvalCase<any, any, any>>(resolvedDataResult)
      ) {
        const iterable = resolvedDataResult as Iterable<
          EvalCase<any, any, any>
        >;
        return (async function* () {
          for (const datum of iterable) {
            yield datum;
          }
        })();
      }
      throw new Error(
        "Evaluator data must be an array, iterable, or async iterable",
      );
    })();

    progressReporter.start(evaluator.evalName, 0);

    const experimentIdPromise: Promise<string | undefined> | undefined =
      experiment
        ? (async () => {
            try {
              return await experiment.id;
            } catch {
              return undefined;
            }
          })()
        : undefined;

    const collectedResults: EvalResult<any, any, any, any>[] = [];
    const localScoreAccumulator: ScoreAccumulator | null = experiment
      ? null
      : {};
    let cancelled = false;
    let scheduledTrials = 0;
    const q = queue(
      async ({
        datum,
        trialIndex,
      }: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        datum: EvalCase<any, any, any>;
        trialIndex: number;
      }) => {
        if (cancelled) {
          return;
        }
        const eventDataset: Dataset | undefined = experiment
          ? experiment.dataset
          : Dataset.isDataset(evaluator.data)
            ? evaluator.data
            : undefined;

        const baseEvent: StartSpanArgs = {
          name: "eval",
          spanAttributes: {
            type: SpanTypeAttribute.EVAL,
          },
          event: {
            input: datum.input,
            expected: "expected" in datum ? datum.expected : undefined,
            tags: datum.tags,
            origin:
              eventDataset && datum.id && datum._xact_id
                ? {
                    object_type: "dataset",
                    object_id: await eventDataset.id,
                    id: datum.id,
                    created: datum.created,
                    _xact_id: datum._xact_id,
                  }
                : undefined,
            ...(datum.upsert_id ? { id: datum.upsert_id } : {}),
          },
        };

        const callback = async (rootSpan: Span) => {
          const state = evaluator.state ?? _internalGetGlobalState();
          const ensureSpansFlushed = async () => {
            // Flush native Braintrust spans
            if (experiment) {
              await flush({ state: experiment.loggingState });
            } else if (state) {
              await flush({ state });
            } else {
              await flush();
            }

            // Also flush OTEL spans if registered
            if (state) {
              await state.flushOtel();
            }
          };

          const parentStr = state.currentParent.getStore();
          const parentComponents = parentStr
            ? SpanComponentsV3.fromStr(parentStr)
            : null;

          const trace = state
            ? new LocalTrace({
                objectType: parentComponents
                  ? spanObjectTypeV3ToTypedString(
                      parentComponents.data.object_type,
                    )
                  : "experiment",
                objectId:
                  parentComponents?.data.object_id ??
                  (experimentIdPromise
                    ? ((await experimentIdPromise) ?? "")
                    : ""),
                rootSpanId: rootSpan.rootSpanId,
                ensureSpansFlushed,
                state,
              })
            : undefined;

          let metadata: Record<string, unknown> = {
            ...("metadata" in datum ? datum.metadata : {}),
          };
          const expected = "expected" in datum ? datum.expected : undefined;
          let output: unknown = undefined;
          let error: unknown | undefined = undefined;
          let tags: string[] = [...(datum.tags ?? [])];
          const scores: Record<string, number | null> = {};
          const scorerNames = evaluator.scores.map(scorerName);
          let unhandledScores: string[] | null = scorerNames;
          try {
            const meta = (o: Record<string, unknown>) =>
              (metadata = { ...metadata, ...o });

            await rootSpan.traced(
              async (span: Span) => {
                const hooksForTask: EvalHooks<
                  unknown,
                  Record<string, unknown>,
                  EvalParameters
                > = {
                  meta,
                  metadata,
                  expected,
                  span,
                  parameters: parameters ?? {},
                  reportProgress: (event: TaskProgressEvent) => {
                    stream?.({
                      ...event,
                      id: rootSpan.id,
                      origin: baseEvent.event?.origin,
                      name: evaluator.evalName,
                      object_type: "task",
                    });
                  },
                  trialIndex,
                  tags,
                };

                const outputResult = evaluator.task(datum.input, hooksForTask);
                if (outputResult instanceof Promise) {
                  output = await outputResult;
                } else {
                  output = outputResult;
                }

                tags = hooksForTask.tags ?? [];

                span.log({ output });
              },
              {
                name: "task",
                spanAttributes: { type: SpanTypeAttribute.TASK },
                event: { input: datum.input },
              },
            );
            if (tags.length) {
              rootSpan.log({ output, metadata, expected, tags });
            } else {
              rootSpan.log({ output, metadata, expected });
            }

            if (evaluator.flushBeforeScoring) {
              await rootSpan.flush();
            }

            const scoringArgs = {
              input: datum.input,
              expected: "expected" in datum ? datum.expected : undefined,
              metadata,
              output,
              trace,
            };
            const scoreResults = await Promise.all(
              evaluator.scores.map(async (score, score_idx) => {
                try {
                  const runScorer = async (span: Span) => {
                    const scoreResult = score(scoringArgs);
                    const scoreValue =
                      scoreResult instanceof Promise
                        ? await scoreResult
                        : scoreResult;

                    if (scoreValue === null) {
                      return null;
                    }

                    if (Array.isArray(scoreValue)) {
                      for (const s of scoreValue) {
                        if (!(typeof s === "object" && !isEmpty(s))) {
                          throw new Error(
                            `When returning an array of scores, each score must be a non-empty object. Got: ${JSON.stringify(
                              s,
                            )}`,
                          );
                        }
                      }
                    }

                    const results = Array.isArray(scoreValue)
                      ? scoreValue
                      : typeof scoreValue === "object" && !isEmpty(scoreValue)
                        ? [scoreValue]
                        : [
                            {
                              name: scorerNames[score_idx],
                              score: scoreValue,
                            },
                          ];

                    const getOtherFields = (s: Score) => {
                      const { metadata: _metadata, name: _name, ...rest } = s;
                      return rest;
                    };

                    const resultMetadata =
                      results.length === 1
                        ? results[0].metadata
                        : results.reduce(
                            (prev, s) =>
                              mergeDicts(prev, {
                                [s.name]: s.metadata,
                              }),
                            {},
                          );

                    const resultOutput =
                      results.length === 1
                        ? getOtherFields(results[0])
                        : results.reduce(
                            (prev, s) =>
                              mergeDicts(prev, { [s.name]: getOtherFields(s) }),
                            {},
                          );

                    const scores = results.reduce(
                      (prev, s) => mergeDicts(prev, { [s.name]: s.score }),
                      {},
                    );

                    span.log({
                      output: resultOutput,
                      metadata: resultMetadata,
                      scores: scores,
                    });
                    return results;
                  };

                  // Exclude trace from logged input since it contains internal state
                  // that shouldn't be serialized (spansFlushPromise, spansFlushed, etc.)
                  const { trace: _trace, ...scoringArgsForLogging } =
                    scoringArgs;
                  const results = await rootSpan.traced(runScorer, {
                    name: scorerNames[score_idx],
                    spanAttributes: {
                      type: SpanTypeAttribute.SCORE,
                      purpose: "scorer",
                    },
                    propagatedEvent: makeScorerPropagatedEvent(
                      await rootSpan.export(),
                    ),
                    event: { input: scoringArgsForLogging },
                  });
                  return { kind: "score", value: results } as const;
                } catch (e) {
                  return { kind: "error", value: e } as const;
                }
              }),
            );
            // Resolve each promise on its own so that we can separate the passing
            // from the failing ones.
            const failingScorersAndResults: { name: string; error: unknown }[] =
              [];
            scoreResults.forEach((results, i) => {
              const name = scorerNames[i];
              if (results.kind === "score") {
                (results.value || []).forEach((result) => {
                  scores[result.name] = result.score;
                });
              } else {
                failingScorersAndResults.push({ name, error: results.value });
              }
            });

            unhandledScores = null;
            if (failingScorersAndResults.length) {
              const scorerErrors = Object.fromEntries(
                failingScorersAndResults.map(({ name, error }) => [
                  name,
                  error instanceof Error ? error.stack : `${error}`,
                ]),
              );
              metadata["scorer_errors"] = scorerErrors;
              rootSpan.log({
                metadata: { scorer_errors: scorerErrors },
              });
              const names = Object.keys(scorerErrors).join(", ");
              const errors = failingScorersAndResults.map((item) => item.error);
              unhandledScores = Object.keys(scorerErrors);
              debugLogger
                .forState(evaluator.state)
                .warn(
                  `Found exceptions for the following scorers: ${names}`,
                  errors,
                );
            }
          } catch (e) {
            logSpanError(rootSpan, e);
            error = e;
          } finally {
            progressReporter.increment(evaluator.evalName);
          }

          const mergedScores = {
            ...(evaluator.errorScoreHandler && unhandledScores
              ? evaluator.errorScoreHandler({
                  rootSpan,
                  data: datum,
                  unhandledScores,
                })
              : undefined),
            ...scores,
          } as Record<string, number | null>;

          if (localScoreAccumulator) {
            accumulateScores(localScoreAccumulator, mergedScores);
          }

          if (collectResults) {
            collectedResults.push({
              input: datum.input,
              ...("expected" in datum ? { expected: datum.expected } : {}),
              output,
              tags: tags.length ? tags : undefined,
              metadata,
              scores: mergedScores,
              error,
              origin: baseEvent.event?.origin,
            });
          }
        };

        if (!experiment) {
          // This will almost always be a no-op span, but it means that if the Eval
          // is run in the context of a different type of span, it will be logged.
          return await traced(callback, {
            ...baseEvent,
            state: evaluator.state,
          });
        } else {
          const result = await experiment.traced(callback, baseEvent);
          // Flush logs to provide backpressure and prevent memory accumulation
          // when maxConcurrency is set. Only flush when pending data exceeds the
          // byte threshold, avoiding excessive sequential round-trips for small
          // payloads while still bounding memory usage for large ones.
          const bgLogger = experiment.loggingState.bgLogger();
          if (
            evaluator.maxConcurrency !== undefined &&
            bgLogger.pendingFlushBytes() >= bgLogger.flushBackpressureBytes()
          ) {
            await experiment.flush();
          }
          return result;
        }
      },
      Math.max(evaluator.maxConcurrency ?? Number.MAX_SAFE_INTEGER, 1),
    );

    const queueErrors: Error[] = [];
    const enqueuePromise = (async () => {
      for await (const datum of dataIterable) {
        if (cancelled) {
          break;
        }
        if (!filters.every((f) => evaluateFilter(datum, f))) {
          continue;
        }
        const trialCount = evaluator.trialCount ?? 1;
        for (let trialIndex = 0; trialIndex < trialCount; trialIndex++) {
          if (cancelled) {
            break;
          }
          scheduledTrials++;
          progressReporter.setTotal?.(evaluator.evalName, scheduledTrials);
          q.pushAsync({ datum, trialIndex }).catch((e) => {
            if (queueErrors.length < 5) {
              // only keep the first 5 errors to avoid unbounded growth
              queueErrors.push(e);
            }
          });
        }
      }
    })();

    const cancel = async () => {
      await new Promise<never>((_, reject) => {
        // If already cancelled, reject immediately
        if (cancelled) {
          reject(new InternalAbortError("Evaluator already cancelled"));
          return;
        }

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let abortHandler: (() => void) | undefined;

        const rejectOnce = (error: InternalAbortError) => {
          if (cancelled) {
            return;
          }
          cancelled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          if (abortHandler && evaluator.signal) {
            evaluator.signal.removeEventListener("abort", abortHandler);
          }
          reject(error);
        };

        if (evaluator.timeout) {
          timeoutId = setTimeout(() => {
            rejectOnce(new InternalAbortError("Evaluator timed out"));
          }, evaluator.timeout);
        }
        if (evaluator.signal) {
          abortHandler = () => {
            rejectOnce(new InternalAbortError("Evaluator aborted"));
          };
          evaluator.signal.addEventListener("abort", abortHandler);
        }
      });
    };

    const waitForQueue = (async () => {
      await enqueuePromise;
      if (q.idle()) {
        return;
      }
      await q.drain();
    })();

    // wait for tasks to be completed or the evaluator to be cancelled
    // if the evaluator is cancelled, the remaining tasks that have not been started will be killed
    try {
      await Promise.race([waitForQueue, cancel()]);
      if (queueErrors.length > 0) {
        throw new AggregateError(
          queueErrors,
          `Encountered ${queueErrors.length} unhandled task errors`,
        );
      }
    } catch (e) {
      // Always kill the queue to prevent hanging tasks and memory leaks
      q.kill();

      if (e instanceof InternalAbortError) {
        // Log cancellation for debugging
        if (iso.getEnv("BRAINTRUST_VERBOSE")) {
          debugLogger
            .forState(evaluator.state)
            .warn("Evaluator cancelled:", e.message);
        }
      }

      throw e;
    } finally {
      // Ensure results are cleared if not collecting to free memory
      if (!collectResults) {
        collectedResults.length = 0;
      }
    }

    const summary = experiment
      ? await experiment.summarize({
          summarizeScores: evaluator.summarizeScores,
        })
      : buildLocalSummary(
          evaluator,
          collectResults ? collectedResults : [],
          localScoreAccumulator ?? undefined,
        );

    return new EvalResultWithSummary(
      summary,
      collectResults ? collectedResults : [],
    );
  } finally {
    // Clean up disk-based span cache after eval completes and stop caching
    // Only if it was enabled
    if (enableCache) {
      const spanCache = (evaluator.state ?? _internalGetGlobalState())
        ?.spanCache;
      spanCache?.dispose();
      spanCache?.stop();
    }
  }
}

export const error = (text: string) => `Error: ${text}`;
export const warning = (text: string) => `Warning: ${text}`;

export function logError(e: unknown, verbose: boolean) {
  if (!verbose) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.error(`${e}`);
  } else {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.error(e);
  }
}

type ScoreAccumulator = {
  [name: string]: { total: number; count: number };
};

function accumulateScores(
  accumulator: ScoreAccumulator,
  scores: Record<string, number | null>,
) {
  for (const [name, score] of Object.entries(scores)) {
    if (score === null || score === undefined) {
      continue;
    }
    const existing = accumulator[name] ?? { total: 0, count: 0 };
    accumulator[name] = {
      total: existing.total + score,
      count: existing.count + 1,
    };
  }
}

function ensureScoreAccumulator(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results: EvalResult<any, any, any, any>[],
) {
  const accumulator: ScoreAccumulator = {};
  for (const result of results) {
    accumulateScores(accumulator, result.scores);
  }
  return accumulator;
}

export function buildLocalSummary(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator: EvaluatorDef<any, any, any, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results: EvalResult<any, any, any, any>[],
  precomputedScores?: ScoreAccumulator,
): ExperimentSummary {
  const scoresByName = precomputedScores ?? ensureScoreAccumulator(results);

  return {
    projectName: evaluator.projectName,
    experimentName: evaluator.evalName,
    scores: Object.fromEntries(
      Object.entries(scoresByName).map(([name, { total, count }]) => [
        name,
        {
          name,
          score: count === 0 ? 0 : total / count,
          improvements: 0,
          regressions: 0,
        },
      ]),
    ),
  };
}

export function reportFailures<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
>(
  evaluator: EvaluatorDef<Input, Output, Expected, Metadata>,
  failingResults: EvalResult<Input, Output, Expected, Metadata>[],
  { verbose, jsonl }: ReporterOpts,
) {
  if (failingResults.length > 0) {
    // TODO: We may want to support a non-strict mode (and make this the "strict" behavior), so that
    // users can still log imperfect evaluations. In the meantime, they should handle these cases inside
    // of their tasks.
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.error(
      warning(
        `Evaluator ${evaluator.evalName} failed with ${failingResults.length} error${failingResults.length === 1 ? "" : "s"}. This evaluation ("${evaluator.evalName}") will not be fully logged.`,
      ),
    );
    if (jsonl) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.log(
        JSON.stringify({
          evaluatorName: evaluator.evalName,
          errors: failingResults.map(
            (r) => `${r.error instanceof Error ? r.error.stack : r.error}`,
          ),
        }),
      );
    } else {
      for (const result of failingResults) {
        logError(result.error, verbose);
      }
    }
    if (!verbose && !jsonl) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.error(
        warning(
          "Use --debug-logging debug to see full stack traces and troubleshooting details.",
        ),
      );
    }
  }
}

/**
 * The default reporter for Braintrust evaluations. This reporter will log the results
 * of each evaluation to the console, and will return false (i.e. fail) if any of the
 * evaluations return an error.
 */
/**
 * Simple plain-text reporter for framework - no fancy formatting dependencies
 */
const defaultReporter: ReporterDef<boolean> = {
  name: "Braintrust default reporter",
  async reportEval(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluator: EvaluatorDef<any, any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: EvalResultWithSummary<any, any, any, any>,
    { verbose, jsonl }: ReporterOpts,
  ) {
    const { results, summary } = result;
    const failingResults = results.filter(
      (r: { error: unknown }) => r.error !== undefined,
    );

    if (failingResults.length > 0) {
      reportFailures(evaluator, failingResults, { verbose, jsonl });
    }

    if (jsonl) {
      iso.writeln(JSON.stringify(summary));
    } else {
      // Simple plain-text output without fancy formatting
      iso.writeln("Experiment summary");
      iso.writeln("==================");

      if (summary.comparisonExperimentName) {
        iso.writeln(
          `${summary.comparisonExperimentName} (baseline) <- ${summary.experimentName} (comparison)`,
        );
        iso.writeln("");
      }

      const hasScores = Object.keys(summary.scores).length > 0;
      const hasMetrics = Object.keys(summary.metrics ?? {}).length > 0;
      const hasComparison = !!summary.comparisonExperimentName;

      if (hasScores || hasMetrics) {
        if (hasComparison) {
          iso.writeln(
            "Name                Value      Change     Improvements Regressions",
          );
          iso.writeln(
            "----------------------------------------------------------------",
          );
        }

        // Scores
        for (const score of Object.values(summary.scores)) {
          const scorePercent = (score.score * 100).toFixed(2);
          const scoreValue = `${scorePercent}%`;

          if (hasComparison) {
            let diffString = "-";
            if (!isEmpty(score.diff)) {
              const diffPercent = (score.diff! * 100).toFixed(2);
              const diffSign = score.diff! > 0 ? "+" : "";
              diffString = `${diffSign}${diffPercent}%`;
            }

            const improvements =
              score.improvements > 0 ? score.improvements.toString() : "-";
            const regressions =
              score.regressions > 0 ? score.regressions.toString() : "-";

            iso.writeln(
              `${score.name.padEnd(18)} ${scoreValue.padStart(10)} ${diffString.padStart(10)} ${improvements.padStart(12)} ${regressions.padStart(11)}`,
            );
          } else {
            iso.writeln(`${score.name.padEnd(20)} ${scoreValue.padStart(15)}`);
          }
        }

        // Metrics
        for (const metric of Object.values(summary.metrics ?? {})) {
          const fractionDigits = Number.isInteger(metric.metric) ? 0 : 2;
          const formattedValue = metric.metric.toFixed(fractionDigits);
          const metricValue =
            metric.unit === "$"
              ? `${metric.unit}${formattedValue}`
              : `${formattedValue}${metric.unit}`;

          if (hasComparison) {
            let diffString = "-";
            if (!isEmpty(metric.diff)) {
              const diffPercent = (metric.diff! * 100).toFixed(2);
              const diffSign = metric.diff! > 0 ? "+" : "";
              diffString = `${diffSign}${diffPercent}%`;
            }

            const improvements =
              metric.improvements > 0 ? metric.improvements.toString() : "-";
            const regressions =
              metric.regressions > 0 ? metric.regressions.toString() : "-";

            iso.writeln(
              `${metric.name.padEnd(18)} ${metricValue.padStart(10)} ${diffString.padStart(10)} ${improvements.padStart(12)} ${regressions.padStart(11)}`,
            );
          } else {
            iso.writeln(
              `${metric.name.padEnd(20)} ${metricValue.padStart(15)}`,
            );
          }
        }
      }

      if (summary.experimentUrl) {
        iso.writeln("");
        iso.writeln(`View results for ${summary.experimentName}`);
        iso.writeln(`See results at ${summary.experimentUrl}`);
      }
    }
    iso.writeln("");
    return failingResults.length === 0;
  },
  async reportRun(evalReports: boolean[]) {
    return evalReports.every((r) => r);
  },
};
