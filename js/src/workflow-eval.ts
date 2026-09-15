import { queue } from "async";
import {
  base64ToUint8Array,
  makeScorerPropagatedEvent,
  SpanTypeAttribute,
  uint8ArrayToBase64,
} from "../util/index";
import {
  type EvalParameters,
  type InferParameters,
  validateParameters,
} from "./eval-parameters";
import {
  _internalInitEvaluatorExperiment,
  _internalPrepareEvaluatorClassification,
  _internalPrepareEvaluatorScore,
  _internalResolveEvaluatorData,
  _internalRunEvaluatorTask,
  buildLocalSummary as buildEvaluatorLocalSummary,
  callEvaluatorData,
  classifierName,
  type EvalClassifier,
  type Evaluator,
  type EvaluatorDef,
  type EvalResult,
  type EvalScorer,
  type EvalScorerArgs,
  type EvalTask,
  type OneOrMoreScores,
  runEvaluator,
} from "./framework";
import iso from "./isomorph";
import {
  type BaseMetadata,
  type DefaultMetadataType,
  type EvalCase,
  type Experiment,
  type ExperimentSummary,
  NOOP_SPAN,
  type Span,
  _internalResumeSpan,
  _internalStartSpanWithInitialMerge,
  logError as logSpanError,
  newId,
} from "./logger";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WORKFLOW_TASK_KIND = "braintrust.workflow.task";
const WORKFLOW_SCORER_KIND = "braintrust.workflow.scorer";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Minimal persistence used to reconnect provider webhooks with provider
 * submissions. Each run, case, and submission is stored under its own key. Workflow
 * evaluations do not require any Braintrust backend changes.
 *
 * @experimental - The API for this interface is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export interface WorkflowEvalStore {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
  /** Atomically stores `value` when `key` is absent and returns its stored value. */
  getOrSet(
    key: string,
    value: Uint8Array,
  ): Promise<{ value: Uint8Array; created: boolean }>;
  /**
   * Atomically adds a unique member to a set. Repeated additions are harmless.
   * Set keys are separate from byte-record keys. Implementations must retain sets
   * for the same lifetime as run records.
   */
  addToSet(key: string, member: string): Promise<void>;
  getSetSize(key: string): Promise<number>;
}

/**
 * Stores workflow evaluation state in memory. State is lost when the current
 * JavaScript process exits.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class WorkflowEvalMemoryStore implements WorkflowEvalStore {
  private readonly values = new Map<string, Uint8Array>();
  private readonly sets = new Map<string, Set<string>>();

  async read(key: string): Promise<Uint8Array | undefined> {
    return this.values.get(key)?.slice();
  }

  async write(key: string, value: Uint8Array): Promise<void> {
    this.values.set(key, value.slice());
  }

  async getOrSet(key: string, value: Uint8Array) {
    const existing = this.values.get(key);
    if (existing) return { value: existing.slice(), created: false };
    this.values.set(key, value.slice());
    return { value: value.slice(), created: true };
  }

  async addToSet(key: string, member: string) {
    let members = this.sets.get(key);
    if (!members) this.sets.set(key, (members = new Set()));
    members.add(member);
  }

  async getSetSize(key: string) {
    return this.sets.get(key)?.size ?? 0;
  }
}

/**
 * Stores workflow evaluation state in Redis using an existing Redis client.
 * Records are base64 encoded. Atomic progress sets use Redis Lua scripts. Clients from `redis` (node-redis), `ioredis`, and
 * `@upstash/redis` can be passed directly.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class WorkflowEvalRedisStore implements WorkflowEvalStore {
  private readonly client: {
    get(key: string): Promise<unknown>;
    set(key: string, value: string): Promise<unknown>;
  };
  private readonly keyPrefix: string;
  private readonly ttlMs: number;

  constructor(options: {
    /** A connected node-redis, ioredis, or Upstash Redis client. */
    client: {
      get(key: string): Promise<unknown>;
      set(key: string, value: string): Promise<unknown>;
    };
    /** Prefix for Redis keys. Defaults to `braintrust-eval:`. */
    keyPrefix?: string;
    /** Entry lifetime in milliseconds. Defaults to seven days. */
    ttlMs?: number;
  }) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? "braintrust-eval:";
    this.ttlMs = options.ttlMs ?? 1000 * 60 * 60 * 24 * 7;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new Error(
        "WorkflowEvalRedisStore ttlMs must be a positive integer",
      );
    }
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    const value = await this.client.get(`${this.keyPrefix}${key}`);
    if (value == null) return undefined;
    if (typeof value !== "string") {
      throw new Error("WorkflowEvalRedisStore expected GET to return a string");
    }
    return base64ToUint8Array(value);
  }

  async write(key: string, value: Uint8Array): Promise<void> {
    const client = this.client as typeof this.client & {
      createScript?: unknown;
      defineCommand?: unknown;
      sendCommand?: unknown;
    };
    const set = client.set as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const redisKey = `${this.keyPrefix}${key}`;
    const encoded = uint8ArrayToBase64(value);
    if (typeof client.defineCommand === "function") {
      await set.call(client, redisKey, encoded, "PX", this.ttlMs);
    } else if (typeof client.sendCommand === "function") {
      await set.call(client, redisKey, encoded, { PX: this.ttlMs });
    } else if (typeof client.createScript === "function") {
      await set.call(client, redisKey, encoded, { px: this.ttlMs });
    } else {
      throw new Error(
        "WorkflowEvalRedisStore requires a node-redis, ioredis, or @upstash/redis client",
      );
    }
  }

  async getOrSet(key: string, value: Uint8Array) {
    const redisKey = `${this.keyPrefix}${key}`;
    const encoded = uint8ArrayToBase64(value);
    const client = this.client as typeof this.client & {
      createScript?: unknown;
      defineCommand?: unknown;
      sendCommand?: unknown;
    };
    const set = client.set as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let setOptions: unknown[];
    if (typeof client.defineCommand === "function") {
      setOptions = ["PX", this.ttlMs, "NX", "GET"];
    } else if (typeof client.sendCommand === "function") {
      setOptions = [{ PX: this.ttlMs, NX: true, GET: true }];
    } else if (typeof client.createScript === "function") {
      setOptions = [{ px: this.ttlMs, nx: true, get: true }];
    } else {
      throw new Error(
        "WorkflowEvalRedisStore getOrSet requires a node-redis, ioredis, or @upstash/redis client",
      );
    }
    const existing = await set.call(client, redisKey, encoded, ...setOptions);
    if (existing === null) return { value: value.slice(), created: true };
    if (typeof existing !== "string") {
      throw new Error(
        "WorkflowEvalRedisStore expected atomic SET to return a string or null",
      );
    }
    return { value: base64ToUint8Array(existing), created: false };
  }

  async addToSet(key: string, member: string) {
    await this.evalSet(
      "redis.call('SADD', KEYS[1], ARGV[1]); redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1",
      key,
      [member, String(this.ttlMs)],
    );
  }

  async getSetSize(key: string) {
    return this.evalSet("return redis.call('SCARD', KEYS[1])", key, []);
  }

  private async evalSet(script: string, key: string, args: string[]) {
    const client = this.client as typeof this.client & {
      eval: (...args: unknown[]) => Promise<unknown>;
      defineCommand?: unknown;
      sendCommand?: unknown;
      createScript?: unknown;
    };
    const redisKey = `${this.keyPrefix}${key}`;
    const result =
      typeof client.defineCommand === "function"
        ? await client.eval(script, 1, redisKey, ...args)
        : typeof client.sendCommand === "function"
          ? await client.eval(script, { keys: [redisKey], arguments: args })
          : await client.eval(script, [redisKey], args);
    if (typeof result !== "number") {
      throw new Error(
        "WorkflowEvalRedisStore expected EVAL to return a number",
      );
    }
    return result;
  }
}

interface WorkflowSubmissionContext {
  runId: string;
  submissionId: string;
}

type WorkflowSubmissionPoll =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "failed"; error: unknown };

type WorkflowSubmissionCompletion<SubmissionData extends JsonValue> =
  | {
      mode: "poll";
      /** Checks whether the provider submission is ready to collect. */
      poll(
        submissionData: SubmissionData,
        context: WorkflowSubmissionContext,
      ): Promise<WorkflowSubmissionPoll>;
    }
  | {
      mode: "webhook";
      /** Returns the provider ID used to match an incoming webhook to this submission. */
      getExternalId(
        submissionData: SubmissionData,
        context: WorkflowSubmissionContext,
      ): string;
    };

export interface WorkflowTaskItem<
  Input,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
> {
  /** Stable identifier for this case and trial within the workflow run. */
  id: string;
  /** Input value from the evaluation case. */
  input: Input;
  /** Expected value from the evaluation case. */
  expected: Expected;
  /** Metadata associated with the evaluation case. */
  metadata: Metadata;
  /** Tags associated with the evaluation case. */
  tags: string[] | undefined;
  /** Parameters supplied when the workflow evaluation started. */
  parameters: InferParameters<Parameters>;
  /** Zero-based trial index for this case. */
  trialIndex: number;
}

type WorkflowTaskResult<Output, Metadata extends BaseMetadata> = {
  /** Task output for the item. */
  output: Output;
  /** Metadata to merge into the evaluation case. */
  metadata?: Metadata;
  /** Tags to replace those from the evaluation case. */
  tags?: string[];
};

export type WorkflowScorerItem<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
> = EvalScorerArgs<Input, Output, Expected, Metadata> & {
  /** Stable identifier for this case and trial within the workflow run. */
  id: string;
  /** Zero-based trial index for this case. */
  trialIndex: number;
};

type WorkflowScorerResult = {
  /** Score or named scores produced for the item. */
  score: OneOrMoreScores;
};

interface WorkflowSubmissionProcessor<
  Item,
  Result,
  SubmissionData extends JsonValue,
> {
  /** Submits one case/trial and returns JSON-serializable provider data. */
  submit(
    item: Item,
    context: WorkflowSubmissionContext,
  ): Promise<SubmissionData>;
  /** Configures how the SDK learns that the submission completed. */
  completion: WorkflowSubmissionCompletion<SubmissionData>;
  /** Collects the result for a completed submission. May be called again on replay. */
  collect(
    submissionData: SubmissionData,
    context: WorkflowSubmissionContext,
  ): Promise<Result>;
}

interface WorkflowTaskDefinition<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
  SubmissionData extends JsonValue,
> {
  readonly kind: typeof WORKFLOW_TASK_KIND;
  readonly processor: WorkflowSubmissionProcessor<
    WorkflowTaskItem<Input, Expected, Metadata, Parameters>,
    WorkflowTaskResult<Output, Metadata>,
    SubmissionData
  >;
}

interface WorkflowScorerDefinition<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  SubmissionData extends JsonValue,
> {
  readonly kind: typeof WORKFLOW_SCORER_KIND;
  name: string;
  readonly processor: WorkflowSubmissionProcessor<
    WorkflowScorerItem<Input, Output, Expected, Metadata>,
    WorkflowScorerResult,
    SubmissionData
  >;
}

/**
 * Defines a task that submits one asynchronous provider operation per case/trial.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class WorkflowTask<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
  SubmissionData extends JsonValue = JsonValue,
> implements WorkflowTaskDefinition<
  Input,
  Output,
  Expected,
  Metadata,
  Parameters,
  SubmissionData
> {
  readonly kind: typeof WORKFLOW_TASK_KIND = WORKFLOW_TASK_KIND;

  constructor(
    readonly processor: WorkflowSubmissionProcessor<
      WorkflowTaskItem<Input, Expected, Metadata, Parameters>,
      WorkflowTaskResult<Output, Metadata>,
      SubmissionData
    >,
  ) {}
}

/**
 * Defines a scorer that submits one asynchronous provider operation per case/trial.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class WorkflowScorer<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  SubmissionData extends JsonValue = JsonValue,
> implements WorkflowScorerDefinition<
  Input,
  Output,
  Expected,
  Metadata,
  SubmissionData
> {
  readonly kind: typeof WORKFLOW_SCORER_KIND = WORKFLOW_SCORER_KIND;
  readonly name: string;

  constructor(
    readonly processor: WorkflowSubmissionProcessor<
      WorkflowScorerItem<Input, Output, Expected, Metadata>,
      WorkflowScorerResult,
      SubmissionData
    > & { name: string },
  ) {
    this.name = processor.name;
  }
}

type WorkflowEvaluator<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> = Omit<
  Evaluator<Input, Output, Expected, Metadata, Parameters>,
  "task" | "scores" | "timeout" | "signal" | "maxConcurrency" | "update"
> & {
  store: WorkflowEvalStore;
  /** Maximum concurrent provider callbacks per invocation. Defaults to 10. */
  maxConcurrency?: number;
  /**
   * Returns a stable case ID when a data item has neither `id` nor `upsert_id`.
   * The ID is shared by all trials of the same case.
   */
  caseId?: (
    datum: EvalCase<Input, Expected, Metadata>,
  ) => string | Promise<string>;
  task:
    | EvalTask<Input, Output, Expected, Metadata, Parameters>
    | WorkflowTaskDefinition<
        Input,
        Output,
        Expected,
        Metadata,
        Parameters,
        JsonValue
      >;
  scores?: Array<
    | EvalScorer<Input, Output, Expected, Metadata>
    | WorkflowScorerDefinition<Input, Output, Expected, Metadata, JsonValue>
  >;
};

interface WorkflowEvalStartOptions<
  Parameters extends EvalParameters = EvalParameters,
> {
  parameters?: InferParameters<Parameters>;
  noSendLogs?: boolean;
}

type WorkflowSubmissionResult = {
  runId: string;
  submissionId?: string;
  externalId?: string;
};

type WorkflowEvalResult =
  | {
      status: "waiting";
      runId: string;
      pending: {
        poll: number;
        webhook: number;
      };
    }
  | {
      status: "completed";
      runId: string;
      pending: {
        poll: 0;
        webhook: 0;
      };
      summary: ExperimentSummary;
    };

interface WorkflowEvalRuntimeDefinition<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> {
  readonly projectName: string;
  readonly evalName: string;
  readonly evaluator: WorkflowEvaluator<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >;
}

interface WorkflowEvalDefinition<Parameters extends EvalParameters> {
  start(
    options?: WorkflowEvalStartOptions<Parameters>,
  ): Promise<WorkflowEvalResult>;
  status(options: { runId: string }): Promise<WorkflowEvalResult>;
  poll(options: { runId: string }): Promise<WorkflowEvalResult>;
  processSubmissionResult(
    result: WorkflowSubmissionResult,
  ): Promise<WorkflowEvalResult>;
}

type WorkflowCaseRecord = {
  id: string;
  caseId: string;
  trialIndex: number;
  datum: JsonValue;
  metadata: JsonValue;
  tags?: string[];
  taskComplete: boolean;
  taskLogged: boolean;
  output?: JsonValue;
  rootSpan?: string;
  scores: Record<string, JsonValue>;
  loggedScores: Record<string, boolean>;
  classifications: Record<string, JsonValue>;
  loggedClassifications: Record<string, boolean>;
};

type WorkflowCaseBaseRecord = Pick<
  WorkflowCaseRecord,
  "id" | "caseId" | "trialIndex" | "datum" | "metadata" | "tags"
>;

type WorkflowTaskResultRecord = Pick<
  WorkflowCaseRecord,
  "output" | "metadata" | "tags"
> & { taskComplete: true };

type WorkflowTaskLogRecord = Pick<WorkflowCaseRecord, "rootSpan"> & {
  taskLogged: true;
};

type WorkflowSubmissionRecord = {
  id: string;
  kind: "task" | "score";
  scorerName?: string;
  itemId: string;
  submissionData: JsonValue;
  externalId?: string;
  status: "submitted" | "complete";
  completionMode: "poll" | "webhook";
};

type WorkflowRunState = {
  runId: string;
  experimentName: string;
  noSendLogs: boolean;
  parameters: JsonValue;
  status: "running" | "completed";
  summary?: ExperimentSummary;
  caseCount: number;
  cases: WorkflowCaseRecord[];
  submissions: WorkflowSubmissionRecord[];
};

type WorkflowRunRecord = Omit<WorkflowRunState, "cases" | "submissions">;

/*
 * Internal usage notes. Keep these out of the public README while
 * defineWorkflowEval() is experimental.
 *
 * ## Workflow evaluations
 *
 * `defineWorkflowEval()` runs tasks and scorers through asynchronous provider
 * operations, one submission per case/trial. A small external store connects
 * submitted jobs with later webhook callbacks; it is required on
 * the eval definition so every invocation uses the same persistence authority.
 * No Braintrust backend changes are required.
 *
 * Every case needs a stable `id` (or a `caseId` function).
 *
 * For local or single-process runs, use the built-in memory store. For workflow
 * deployments, the Redis adapter accepts any existing client with asynchronous
 * `get(key)` and `set(key, value)` methods. The adapter itself adds no Redis
 * dependency, so install and configure whichever client your application already
 * uses.
 *
 * The following popular clients can be passed directly to
 * `WorkflowEvalRedisStore`:
 *
 * - [`redis`](https://github.com/redis/node-redis) (node-redis), including the
 *   lower-level `@redis/client` package
 * - [`ioredis`](https://github.com/redis/ioredis)
 * - [`@upstash/redis`](https://upstash.com/docs/redis/sdks/ts/deployment),
 *   including its platform-specific entrypoints
 *
 * Choose the example for your client:
 *
 * node-redis (`redis` or `@redis/client`):
 *
 * ```typescript
 * import { createClient } from "redis";
 * import { WorkflowEvalRedisStore } from "braintrust";
 *
 * const nodeRedis = await createClient({ url: process.env.REDIS_URL! }).connect();
 * const redisStore = new WorkflowEvalRedisStore({ client: nodeRedis });
 * ```
 *
 * ioredis:
 *
 * ```typescript
 * import Redis from "ioredis";
 * import { WorkflowEvalRedisStore } from "braintrust";
 *
 * const ioRedis = new Redis(process.env.REDIS_URL!);
 * const redisStore = new WorkflowEvalRedisStore({ client: ioRedis });
 * ```
 *
 * Upstash:
 *
 * ```typescript
 * import { Redis } from "@upstash/redis";
 * import { WorkflowEvalRedisStore } from "braintrust";
 *
 * const upstashRedis = Redis.fromEnv();
 * const redisStore = new WorkflowEvalRedisStore({ client: upstashRedis });
 * ```
 *
 * Redis entries expire after seven days by default. Set `ttlMs` in the store
 * options to use a different lifetime. For local testing,
 * `new WorkflowEvalMemoryStore()` requires no external client, but is
 * process-local and loses its state when the process exits, so it should not be
 * used to reconnect webhooks across serverless invocations.
 *
 * ```typescript
 * import { WorkflowTask, defineWorkflowEval } from "braintrust";
 *
 * const supportEval = defineWorkflowEval("Support bot", {
 *   store: redisStore,
 *   data: [{ id: "password-reset", input: "How do I reset my password?" }],
 *   task: new WorkflowTask({
 *     async submit(item, { runId, submissionId }) {
 *       const request = await provider.submit({
 *         input: item.input,
 *         idempotencyKey: submissionId,
 *         metadata: { runId, submissionId },
 *       });
 *       return { id: request.id };
 *     },
 *     completion: {
 *       mode: "webhook",
 *       getExternalId: (submission) => submission.id,
 *     },
 *     async collect(submission) {
 *       return { output: await provider.result(submission.id) };
 *     },
 *   }),
 *   scores: [({ output }) => output.length > 0 ? 1 : 0],
 * });
 *
 * const { runId } = await supportEval.start();
 * await supportEval.processSubmissionResult({ runId, externalId: event.id });
 * ```
 *
 * Each submission belongs to one case/trial. `WorkflowScorer` has the same
 * lifecycle, requires a `name`, and collects `{ score }` instead of `{ output }`.
 * Task results may include `metadata` to merge and `tags` to replace case tags.
 * Submission data and collected values must be JSON serializable.
 *
 * Use `completion: { mode: "poll", poll }` for polling providers. The callback
 * receives submission data and `{ runId, submissionId }`, and returns
 * `{ status: "pending" }`, `{ status: "complete" }`, or
 * `{ status: "failed", error }`. Invoke `poll({ runId })` from a cron or worker;
 * it checks each existing polling submission once without sleeping. Newly
 * submitted work is polled on a later invocation.
 *
 * `processSubmissionResult()` accepts either the provider's `externalId` or the
 * SDK's `submissionId`, plus `runId`. Collection callbacks must tolerate repeated
 * invocation, including concurrent webhook deliveries. Provider webhook failure
 * handling remains the application's responsibility.
 *
 * `start()`, `poll()`, and `processSubmissionResult()` return the current status.
 * Waiting statuses include `pending: { poll, webhook }`, counting outstanding
 * submissions. Completed statuses include the saved experiment summary and zero
 * pending submissions. `status({ runId })` reads status without advancing work.
 *
 * Once a task result is persisted and logged, that case's scorers and classifiers
 * can start even while other tasks are pending. The run completes only after all
 * cases finish. Ordinary task and scorer functions are also supported.
 *
 * Provider submissions and polling use `maxConcurrency` (default 10). A failed
 * provider callback is reported after independent submissions have advanced.
 */

/**
 * Defines a workflow evaluation backed by a user-provided store.
 *
 * @experimental - The API for this function is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export function defineWorkflowEval<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
>(
  projectName: string,
  evaluator: WorkflowEvaluator<Input, Output, Expected, Metadata, Parameters>,
): WorkflowEvalDefinition<Parameters> {
  if (
    evaluator.maxConcurrency !== undefined &&
    (!Number.isInteger(evaluator.maxConcurrency) ||
      evaluator.maxConcurrency < 1)
  ) {
    throw new Error("maxConcurrency must be a positive integer");
  }
  const definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  > = {
    projectName,
    evalName: evaluator.experimentName ?? projectName,
    evaluator,
  };
  return {
    start: (options = {}) => startWorkflowEval(definition, options),
    status: (options) => getWorkflowEvalStatus(definition, options),
    poll: (options) => pollWorkflowEval(definition, options),
    processSubmissionResult: (result) =>
      processWorkflowSubmissionResult(definition, result),
  };
}

async function startWorkflowEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  options: WorkflowEvalStartOptions<Parameters>,
): Promise<WorkflowEvalResult> {
  const store = definition.evaluator.store;
  const runId = newId();
  const key = runKey(definition.projectName, definition.evalName, runId);
  const { data } = callEvaluatorData(definition.evaluator.data);
  const parameters = await validateParameters(
    options.parameters ?? {},
    definition.evaluator.parameters,
  );
  const experimentName =
    definition.evaluator.experimentName ?? `${definition.evalName}-${runId}`;
  const experiment = await _internalInitEvaluatorExperiment(
    definition.projectName,
    { ...definition.evaluator, data } as unknown as Evaluator<
      Input,
      Output,
      Expected,
      Metadata,
      Parameters
    >,
    data,
    {
      disabled: options.noSendLogs ?? false,
      experimentName,
      update: true,
    },
  );
  if (
    !isWorkflowTask(definition.evaluator.task) &&
    !(definition.evaluator.scores ?? []).some(isWorkflowScorer)
  ) {
    const result = await runEvaluator(
      experiment,
      {
        ...definition.evaluator,
        projectName: definition.projectName,
        evalName: definition.evalName,
        data,
      } as unknown as EvaluatorDef<
        Input,
        Output,
        Expected,
        Metadata,
        Parameters
      >,
      {
        start: () => undefined,
        stop: () => undefined,
        increment: () => undefined,
      },
      [],
      undefined,
      parameters,
      true,
      true,
    );
    const state: WorkflowRunState = {
      runId,
      experimentName,
      noSendLogs: options.noSendLogs ?? false,
      parameters: assertJsonValue(parameters, "eval parameters"),
      status: "completed",
      summary: result.summary,
      caseCount: 0,
      cases: [],
      submissions: [],
    };
    await experiment?.flush();
    await writeRunRecord(store, key, state);
    return currentStatus(definition, state);
  }
  const cases = await materializeCases(definition, data, experiment);
  const state: WorkflowRunState = {
    runId,
    experimentName,
    noSendLogs: options.noSendLogs ?? false,
    parameters: assertJsonValue(parameters, "eval parameters"),
    status: "running",
    caseCount: cases.length,
    cases,
    submissions: [],
  };
  await writeJson(
    store,
    `${key}/case-ids`,
    cases.map(({ id }) => id),
  );
  await writeCaseBaseRecords(store, key, state.cases);
  await writeRunRecord(store, key, state);
  return advanceWorkflowEval(definition, state, store, key, experiment);
}

async function getWorkflowEvalStatus<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  options: { runId: string },
): Promise<WorkflowEvalResult> {
  const store = definition.evaluator.store;
  const key = runKey(
    definition.projectName,
    definition.evalName,
    options.runId,
  );
  const state = await readJson<WorkflowRunRecord>(store, key);
  if (!state) throw new Error(`Workflow eval run ${options.runId} is missing`);
  return currentStatus(definition, state);
}

async function processWorkflowSubmissionResult<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  result: WorkflowSubmissionResult,
): Promise<WorkflowEvalResult> {
  if (!result.submissionId && !result.externalId) {
    throw new Error("Submission results require submissionId or externalId");
  }
  const store = definition.evaluator.store;
  const key = runKey(definition.projectName, definition.evalName, result.runId);
  const run = await readJson<WorkflowRunRecord>(store, key);
  if (!run) throw new Error(`Workflow eval run ${result.runId} is missing`);
  const externalSubmissionId = result.externalId
    ? await readJson<string>(
        store,
        `${key}/external/${encodedKeyPart(result.externalId)}`,
      )
    : undefined;
  if (
    result.submissionId &&
    externalSubmissionId &&
    result.submissionId !== externalSubmissionId
  ) {
    throw new Error(
      "submissionId and externalId identify different submissions",
    );
  }
  const submissionId = result.submissionId ?? externalSubmissionId;
  const submission = submissionId
    ? await readJson<WorkflowSubmissionRecord>(
        store,
        submissionRecordKey(key, submissionId),
      )
    : undefined;
  if (!submission) throw new Error("No submission matches this result");
  if (result.externalId && submission.externalId !== result.externalId) {
    throw new Error(
      "submissionId and externalId identify different submissions",
    );
  }
  if (run.status === "completed") return currentStatus(definition, run);
  const state = (await readRunState(definition, store, key, [
    submission.itemId,
  ]))!;
  if (submission.status !== "complete") {
    const record = await collectSubmission(definition, state, submission);
    await writeCaseRecords(store, key, [record]);
    submission.status = "complete";
  }
  // Repeat progress writes on replay to recover an interrupted persistence step.
  await writeSubmissionRecords(store, key, [submission]);
  return advanceWorkflowEval(
    definition,
    (await readRunState(definition, store, key, [submission.itemId]))!,
    store,
    key,
  );
}

async function pollWorkflowEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  options: { runId: string },
): Promise<WorkflowEvalResult> {
  const store = definition.evaluator.store;
  const key = runKey(
    definition.projectName,
    definition.evalName,
    options.runId,
  );
  const state = await readRunState(definition, store, key);
  if (!state) throw new Error(`Workflow eval run ${options.runId} is missing`);

  const submissions = state.submissions.filter((submission) => {
    if (submission.status === "complete") return false;
    return (
      processorForStage(definition, submission.kind, submission.scorerName)
        .completion.mode === "poll"
    );
  });
  const workers = queue(async (submission: WorkflowSubmissionRecord) => {
    const completion = processorForStage(
      definition,
      submission.kind,
      submission.scorerName,
    ).completion;
    if (completion.mode !== "poll") return;
    const result = await completion.poll(submission.submissionData, {
      runId: state.runId,
      submissionId: submission.id,
    });
    if (result.status === "failed") throw asError(result.error);
    if (result.status === "complete") {
      const record = await collectSubmission(definition, state, submission);
      await writeCaseRecords(store, key, [record]);
      submission.status = "complete";
      await writeSubmissionRecords(store, key, [submission]);
    }
  }, definition.evaluator.maxConcurrency ?? 10);
  const results = await Promise.allSettled(
    submissions.map((submission) => workers.pushAsync(submission)),
  );
  // Advance persisted work even when an unrelated provider callback failed.
  let status: WorkflowEvalResult | undefined;
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [asError(result.reason)] : [],
  );
  try {
    status = await advanceWorkflowEval(
      definition,
      (await readRunState(definition, store, key))!,
      store,
      key,
    );
  } catch (error) {
    errors.push(asError(error));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Workflow submission callbacks failed");
  return status!;
}

async function openWorkflowExperiment(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
) {
  const data: EvalCase<unknown, unknown, BaseMetadata>[] = [];
  return await _internalInitEvaluatorExperiment(
    definition.projectName,
    { ...definition.evaluator, data } as unknown as Evaluator<
      unknown,
      unknown,
      unknown,
      BaseMetadata,
      EvalParameters
    >,
    data,
    {
      disabled: state.noSendLogs,
      experimentName: state.experimentName,
      update: true,
    },
  );
}

async function advanceWorkflowEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  state: WorkflowRunState,
  store: WorkflowEvalStore,
  key: string,
  existingExperiment?: Experiment | null,
): Promise<WorkflowEvalResult> {
  if (state.status === "completed") return currentStatus(definition, state);
  const experiment =
    existingExperiment === undefined
      ? await openWorkflowExperiment(definition, state)
      : existingExperiment;
  const caseIds = state.cases.map(({ id }) => id);
  await runTaskStage(definition, state, store, key, experiment);
  await logCompletedTasks(definition, state, store, key, experiment);
  state = (await readRunState(definition, store, key, caseIds)) ?? state;
  await runScoreStages(definition, state, store, key, experiment);
  state = (await readRunState(definition, store, key, caseIds)) ?? state;
  const scorerNames = resolveScorers(definition.evaluator.scores ?? []).map(
    ({ name }) => name,
  );
  const classifierNames = (definition.evaluator.classifiers ?? []).map(
    classifierName,
  );
  await Promise.all(
    state.cases.map(async (record) => {
      if (
        record.taskComplete &&
        record.taskLogged &&
        scorerNames.every(
          (name) =>
            Object.hasOwn(record.scores, name) &&
            Object.hasOwn(record.loggedScores, name),
        ) &&
        classifierNames.every((name) =>
          Object.hasOwn(record.loggedClassifications, name),
        )
      ) {
        await store.addToSet(`${key}/progress/cases`, record.id);
      }
    }),
  );
  if ((await store.getSetSize(`${key}/progress/cases`)) !== state.caseCount) {
    return currentStatus(definition, state);
  }

  if (!(await claimAction(store, key, "finish"))) {
    const latest = await readJson<WorkflowRunRecord>(store, key);
    return currentStatus(definition, latest ?? state);
  }
  state = (await readRunState(definition, store, key))!;
  state.summary = await finishExperiment(definition, state, experiment);
  state.status = "completed";
  await writeRunRecord(store, key, state);
  return currentStatus(definition, state);
}

async function currentStatus(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunRecord,
): Promise<WorkflowEvalResult> {
  if (state.status === "completed") {
    if (!state.summary) {
      throw new Error(`Workflow eval run ${state.runId} has no saved summary`);
    }
    return {
      status: "completed",
      runId: state.runId,
      pending: { poll: 0, webhook: 0 },
      summary: state.summary,
    };
  }
  const key = runKey(definition.projectName, definition.evalName, state.runId);
  const store = definition.evaluator.store;
  const pending = { poll: 0, webhook: 0 };
  await Promise.all(
    (["poll", "webhook"] as const).map(async (mode) => {
      // Read completions first so an in-flight submission cannot yield a negative count.
      const completed = await store.getSetSize(
        `${key}/progress/${mode}/complete`,
      );
      const submitted = await store.getSetSize(
        `${key}/progress/${mode}/submitted`,
      );
      pending[mode] = submitted - completed;
    }),
  );
  return { status: "waiting", runId: state.runId, pending };
}

async function startCaseRoot(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  record: WorkflowCaseRecord,
  experiment: Experiment | null,
): Promise<Span> {
  if (!experiment) return NOOP_SPAN;
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  return _internalStartSpanWithInitialMerge({
    ...(definition.evaluator.state
      ? { state: definition.evaluator.state }
      : {}),
    parent: await experiment.export(),
    name: "eval",
    spanId: deterministicId(`${state.runId}:${record.id}:span`),
    spanAttributes: { type: SpanTypeAttribute.EVAL },
    event: {
      id: deterministicId(`${state.runId}:${record.id}:row`),
      input: datum.input,
      expected: "expected" in datum ? datum.expected : undefined,
      tags: datum.tags,
      origin: datum.origin,
    },
  });
}

async function logTaskResult(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  record: WorkflowCaseRecord,
  experiment: Experiment | null,
  task?: EvalTask<any, any, any, any, any>,
) {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  const root = await startCaseRoot(definition, state, record, experiment);
  try {
    if (task) {
      const result = await root.traced(
        (span) =>
          _internalRunEvaluatorTask(
            task,
            datum,
            record.trialIndex,
            state.parameters as Record<string, unknown>,
            span,
          ),
        {
          name: "task",
          spanId: deterministicId(`${state.runId}:${record.id}:task`),
          spanAttributes: { type: SpanTypeAttribute.TASK },
          event: { input: datum.input },
        },
      );
      record.output = assertJsonValue(
        result.output,
        `task output for ${record.caseId}`,
      );
      record.metadata = assertJsonValue(result.metadata, "task metadata");
      record.tags = result.tags;
      record.taskComplete = true;
    } else {
      await root.traced((span) => span.log({ output: record.output }), {
        name: "task",
        spanId: deterministicId(`${state.runId}:${record.id}:task`),
        spanAttributes: { type: SpanTypeAttribute.TASK },
        event: { input: datum.input },
      });
    }
    root.log({
      output: record.output,
      expected: "expected" in datum ? datum.expected : undefined,
      metadata: {
        ...(record.metadata as Record<string, unknown>),
        workflow_eval: {
          run_id: state.runId,
          case_id: record.caseId,
          trial_index: record.trialIndex,
        },
      },
      tags: record.tags,
    });
    record.rootSpan = await root.export();
    record.taskLogged = true;
  } catch (error) {
    logSpanError(root, error);
    throw error;
  } finally {
    root.end();
  }
}

async function logCompletedTasks(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  store: WorkflowEvalStore,
  key: string,
  experiment: Experiment | null,
) {
  const changed: WorkflowCaseRecord[] = [];
  for (const record of state.cases) {
    if (!record.taskComplete || record.taskLogged) continue;
    if (!(await claimAction(store, key, "task-log", record.id))) continue;
    await logTaskResult(definition, state, record, experiment);
    changed.push(record);
  }
  if (changed.length > 0) {
    await experiment?.flush();
    await writeCaseRecords(store, key, changed);
  }
}

async function runTaskStage<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  state: WorkflowRunState,
  store: WorkflowEvalStore,
  key: string,
  experiment: Experiment | null,
) {
  if (isWorkflowTask(definition.evaluator.task)) {
    await ensureSubmissions(definition, state, store, key, "task");
    return;
  }

  const task = definition.evaluator.task as EvalTask<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >;
  const changed: WorkflowCaseRecord[] = [];
  for (const record of state.cases) {
    if (record.taskComplete) continue;
    if (!(await claimAction(store, key, "task", record.id))) continue;
    await logTaskResult(definition, state, record, experiment, task);
    changed.push(record);
  }
  if (changed.length > 0) {
    await experiment?.flush();
    await writeCaseRecords(store, key, changed);
  }
}

async function runScoreStages<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  state: WorkflowRunState,
  store: WorkflowEvalStore,
  key: string,
  experiment: Experiment | null,
) {
  const scorers = resolveScorers(definition.evaluator.scores ?? []);
  const changed = new Map<string, WorkflowCaseRecord>();
  const persistChangedCases = async () => {
    if (changed.size === 0) return;
    await experiment?.flush();
    await writeCaseRecords(store, key, [...changed.values()]);
    changed.clear();
  };
  for (const { name, scorer } of scorers) {
    if (isWorkflowScorer(scorer)) {
      for (const record of state.cases) {
        if (!record.taskComplete || !record.taskLogged) continue;
        if (
          Object.hasOwn(record.scores, name) &&
          !Object.hasOwn(record.loggedScores, name)
        ) {
          if (!(await claimAction(store, key, "score-log", record.id, name))) {
            continue;
          }
          await evaluateAndLogScore(
            definition,
            state,
            record,
            name,
            experiment,
          );
          changed.set(record.id, record);
        }
      }
      await persistChangedCases();
      await ensureSubmissions(definition, state, store, key, "score", name);
      continue;
    }
    for (const record of state.cases) {
      if (!record.taskComplete || !record.taskLogged) continue;
      if (Object.hasOwn(record.loggedScores, name)) continue;
      if (!(await claimAction(store, key, "score", record.id, name))) continue;
      await evaluateAndLogScore(
        definition,
        state,
        record,
        name,
        experiment,
        scorer,
      );
      changed.set(record.id, record);
    }
  }

  for (const [index, classifier] of (
    definition.evaluator.classifiers ?? []
  ).entries()) {
    const name = classifierName(classifier, index);
    for (const record of state.cases) {
      if (!record.taskComplete || !record.taskLogged) continue;
      if (Object.hasOwn(record.loggedClassifications, name)) continue;
      if (!(await claimAction(store, key, "classification", record.id, name))) {
        continue;
      }
      await evaluateAndLogClassification(
        definition,
        state,
        record,
        name,
        classifier,
        experiment,
      );
      changed.set(record.id, record);
    }
  }
  await persistChangedCases();
}

function scorerArgs(record: WorkflowCaseRecord) {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  return {
    ...datum,
    metadata: record.metadata,
    tags: record.tags,
    output: record.output,
  } as EvalScorerArgs<unknown, unknown, unknown, BaseMetadata>;
}

function resumeCaseRoot(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  record: WorkflowCaseRecord,
  experiment: Experiment | null,
) {
  if (!experiment) return NOOP_SPAN;
  if (!record.rootSpan) {
    throw new Error(`Workflow eval case ${record.caseId} has no root span`);
  }
  return _internalResumeSpan({
    exported: record.rootSpan,
    state: definition.evaluator.state,
  });
}

async function evaluateAndLogScore(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  record: WorkflowCaseRecord,
  name: string,
  experiment: Experiment | null,
  scorer?: EvalScorer<any, any, any, any>,
) {
  const root = resumeCaseRoot(definition, record, experiment);
  try {
    const rootExport = await root.export();
    const prepared = await root.traced(
      async (span) => {
        const value = scorer
          ? await scorer(scorerArgs(record))
          : (record.scores[name] as OneOrMoreScores);
        if (scorer) {
          record.scores[name] = assertJsonValue(value, `scorer ${name} output`);
        }
        const result = _internalPrepareEvaluatorScore(value, name);
        if (result.results !== null) {
          span.log({
            output: result.output,
            metadata: result.metadata,
            scores: result.scores,
          });
        }
        return result;
      },
      {
        name,
        spanId: deterministicId(`${state.runId}:${record.id}:score:${name}`),
        spanAttributes: {
          type: SpanTypeAttribute.SCORE,
          purpose: "scorer",
        },
        propagatedEvent: makeScorerPropagatedEvent(rootExport || undefined),
        event: { input: scorerArgs(record) },
      },
    );
    if (prepared.scores) root.log({ scores: prepared.scores });
    record.loggedScores[name] = true;
  } catch (error) {
    logSpanError(root, error);
    throw error;
  } finally {
    root.end();
  }
}

async function evaluateAndLogClassification(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  record: WorkflowCaseRecord,
  name: string,
  classifier: EvalClassifier<any, any, any, any>,
  experiment: Experiment | null,
) {
  const root = resumeCaseRoot(definition, record, experiment);
  try {
    const rootExport = await root.export();
    const prepared = await root.traced(
      async (span) => {
        const value = await classifier(scorerArgs(record));
        record.classifications[name] = assertJsonValue(
          value,
          `classifier ${name} output`,
        );
        const result = _internalPrepareEvaluatorClassification(value, name);
        if (result.results !== null) {
          span.log({ output: result.output, metadata: result.metadata });
        }
        return result;
      },
      {
        name,
        spanId: deterministicId(
          `${state.runId}:${record.id}:classification:${name}`,
        ),
        spanAttributes: {
          type: SpanTypeAttribute.CLASSIFIER,
          purpose: "scorer",
        },
        propagatedEvent: makeScorerPropagatedEvent(rootExport || undefined),
        event: { input: scorerArgs(record) },
      },
    );
    if (prepared.classifications) {
      root.log({ classifications: prepared.classifications });
    }
    record.loggedClassifications[name] = true;
  } catch (error) {
    logSpanError(root, error);
    throw error;
  } finally {
    root.end();
  }
}

async function ensureSubmissions(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  store: WorkflowEvalStore,
  key: string,
  kind: "task" | "score",
  scorerName?: string,
) {
  const processor = processorForStage(definition, kind, scorerName);
  const plans = plannedSubmissions(
    definition,
    state.runId,
    state.cases.map(({ id }) => id),
  );
  const casesById = new Map(state.cases.map((record) => [record.id, record]));
  const existingIds = new Set(state.submissions.map(({ id }) => id));
  const workers = queue(async (plan: WorkflowSubmissionPlan) => {
    if (plan.kind !== kind || plan.scorerName !== scorerName) return;
    if (existingIds.has(plan.id)) return;
    const record = casesById.get(plan.itemId)!;
    const ready =
      kind === "task"
        ? !record.taskComplete
        : record.taskComplete &&
          record.taskLogged &&
          !Object.hasOwn(record.scores, scorerName!);
    if (!ready) return;
    const submissionId = plan.id;
    const claim = await store.getOrSet(
      claimRecordKey(key, "submission", submissionId),
      encoder.encode(submissionId),
    );
    if (!claim.created) return;
    const context = { runId: state.runId, submissionId };
    const item =
      kind === "task"
        ? taskSubmissionItem(record, state.parameters)
        : scorerSubmissionItem(record);
    const submissionData = assertJsonValue(
      await processor.submit(item, context),
      `submission data for submission ${submissionId}`,
    );
    const externalId =
      processor.completion.mode === "webhook"
        ? processor.completion.getExternalId(submissionData, context)
        : undefined;
    if (externalId !== undefined && !externalId.trim()) {
      throw new Error(
        `Submission ${submissionId} produced an empty externalId`,
      );
    }
    const submission: WorkflowSubmissionRecord = {
      id: submissionId,
      kind,
      scorerName,
      itemId: record.id,
      submissionData,
      externalId,
      status: "submitted",
      completionMode: processor.completion.mode,
    };
    state.submissions.push(submission);
    await writeSubmissionRecords(store, key, [submission]);
  }, definition.evaluator.maxConcurrency ?? 10);
  const results = await Promise.allSettled(
    plans.map((plan) => workers.pushAsync(plan)),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [asError(result.reason)] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Workflow submissions failed");
}

async function collectSubmission(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  submission: WorkflowSubmissionRecord,
) {
  const processor = processorForStage(
    definition,
    submission.kind,
    submission.scorerName,
  );
  const context = { runId: state.runId, submissionId: submission.id };
  const result = await processor.collect(submission.submissionData, context);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(
      `collect for submission ${submission.id} must return a result object`,
    );
  }
  const record = state.cases.find(
    (candidate) => candidate.id === submission.itemId,
  )!;
  if (submission.kind === "task") {
    record.output = assertJsonValue(
      result.output,
      `task output for item ${record.id}`,
    );
    if (result.metadata !== undefined) {
      record.metadata = assertJsonValue(
        { ...(record.metadata as Record<string, unknown>), ...result.metadata },
        `metadata for ${record.id}`,
      );
    }
    if (result.tags !== undefined) record.tags = result.tags;
    record.taskComplete = true;
  } else {
    record.scores[submission.scorerName!] = assertJsonValue(
      result.score,
      `score output for item ${record.id}`,
    );
  }
  return record;
}

function processorForStage(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  kind: "task" | "score",
  scorerName?: string,
): WorkflowSubmissionProcessor<any, any, JsonValue> {
  if (kind === "task") {
    if (!isWorkflowTask(definition.evaluator.task)) {
      throw new Error("Definition no longer contains the submission task");
    }
    return definition.evaluator.task.processor as WorkflowSubmissionProcessor<
      any,
      any,
      JsonValue
    >;
  }
  const scorer = resolveScorers(definition.evaluator.scores ?? []).find(
    ({ name }) => name === scorerName,
  )?.scorer;
  if (!isWorkflowScorer(scorer)) {
    throw new Error(`Definition no longer contains scorer ${scorerName}`);
  }
  return scorer.processor as WorkflowSubmissionProcessor<any, any, JsonValue>;
}

async function materializeCases<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: WorkflowEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  data: Evaluator<Input, Output, Expected, Metadata, Parameters>["data"],
  experiment: Experiment | null,
): Promise<WorkflowCaseRecord[]> {
  const evaluator = definition.evaluator;
  const iterable = await _internalResolveEvaluatorData(
    {
      data,
      projectName: definition.projectName,
      projectId: evaluator.projectId,
      state: evaluator.state,
    },
    experiment,
  );
  const records: WorkflowCaseRecord[] = [];
  const seen = new Set<string>();
  for await (const datum of iterable) {
    const caseId =
      datum.id ??
      datum.upsert_id ??
      (evaluator.caseId
        ? await evaluator.caseId(datum as EvalCase<Input, Expected, Metadata>)
        : undefined);
    if (!caseId) {
      throw new Error(
        "Every workflow eval case requires id, upsert_id, or caseId",
      );
    }
    if (seen.has(caseId))
      throw new Error(`Duplicate workflow eval case id: ${caseId}`);
    seen.add(caseId);
    const trialCount = datum.trialCount ?? evaluator.trialCount ?? 1;
    if (!Number.isInteger(trialCount) || trialCount < 1) {
      throw new Error(`Invalid trialCount for workflow eval case ${caseId}`);
    }
    for (let trialIndex = 0; trialIndex < trialCount; trialIndex++) {
      records.push({
        id: `${caseId}:trial:${trialIndex}`,
        caseId,
        trialIndex,
        datum: assertJsonValue(datum, `case ${caseId}`),
        metadata: assertJsonValue(
          "metadata" in datum ? datum.metadata : {},
          `metadata for ${caseId}`,
        ),
        tags: datum.tags,
        taskComplete: false,
        taskLogged: false,
        scores: Object.create(null),
        loggedScores: Object.create(null),
        classifications: Object.create(null),
        loggedClassifications: Object.create(null),
      });
    }
  }
  return records;
}

function taskSubmissionItem(record: WorkflowCaseRecord, parameters: JsonValue) {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  return {
    id: record.id,
    input: datum.input,
    expected: "expected" in datum ? datum.expected : undefined,
    metadata: record.metadata,
    tags: record.tags,
    parameters,
    trialIndex: record.trialIndex,
  };
}

function scorerSubmissionItem(record: WorkflowCaseRecord) {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  return {
    id: record.id,
    input: datum.input,
    output: record.output,
    expected: "expected" in datum ? datum.expected : undefined,
    metadata: record.metadata,
    tags: record.tags,
    trialIndex: record.trialIndex,
  };
}

async function finishExperiment(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  state: WorkflowRunState,
  experiment: Experiment | null,
) {
  const scorerNames = resolveScorers(definition.evaluator.scores ?? []).map(
    ({ name }) => name,
  );
  const results = state.cases.map((record) => {
    const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
    const scores = Object.fromEntries(
      scorerNames.flatMap((name) =>
        Object.entries(
          _internalPrepareEvaluatorScore(
            record.scores[name] as OneOrMoreScores,
            name,
          ).scores ?? {},
        ),
      ),
    );
    const classifications = Object.fromEntries(
      Object.entries(record.classifications).flatMap(([name, value]) =>
        Object.entries(
          _internalPrepareEvaluatorClassification(value as never, name)
            .classifications ?? {},
        ),
      ),
    );
    return {
      ...datum,
      output: record.output,
      metadata: record.metadata,
      tags: record.tags,
      scores,
      error: undefined,
      ...(Object.keys(classifications).length > 0 ? { classifications } : {}),
    } as EvalResult<unknown, unknown, unknown, BaseMetadata>;
  });
  if (!experiment) {
    return buildEvaluatorLocalSummary(
      {
        ...definition.evaluator,
        projectName: definition.projectName,
        evalName: state.experimentName,
      } as unknown as EvaluatorDef<unknown, unknown, unknown, BaseMetadata>,
      results,
    );
  }
  await experiment.flush();
  let comparisonExperimentId = definition.evaluator.baseExperimentId;
  if (!comparisonExperimentId) {
    try {
      comparisonExperimentId = await experiment._getBaseExperimentId();
    } catch {
      comparisonExperimentId = undefined;
    }
  }
  return await experiment.summarize({
    summarizeScores: definition.evaluator.summarizeScores,
    ...(comparisonExperimentId ? { comparisonExperimentId } : {}),
  });
}

function resolveScorers(
  scorers: Array<
    | EvalScorer<any, any, any, any>
    | WorkflowScorerDefinition<any, any, any, any, JsonValue>
  >,
) {
  return scorers.map((scorer, index) => ({
    name: isWorkflowScorer(scorer)
      ? scorer.name
      : scorer.name || `scorer_${index}`,
    scorer,
  }));
}

function runKey(projectName: string, evalName: string, runId: string) {
  return `workflow-eval/v1/runs/${contentVersion(encoder.encode(`${projectName}\0${evalName}\0${runId}`))}`;
}

function encodedKeyPart(value: string) {
  return uint8ArrayToBase64(encoder.encode(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function caseRecordKey(
  key: string,
  caseId: string,
  kind:
    | "base"
    | "task"
    | "task-log"
    | "score"
    | "score-log"
    | "classification"
    | "classification-log",
  ...names: string[]
) {
  const suffix = names.map(encodedKeyPart).join("/");
  return `${key}/cases/${encodedKeyPart(caseId)}/${kind}${suffix ? `/${suffix}` : ""}`;
}

function submissionRecordKey(key: string, submissionId: string) {
  return `${key}/submissions/${encodedKeyPart(submissionId)}`;
}

function claimRecordKey(key: string, kind: string, ...parts: string[]) {
  const identity = stableStringify([kind, parts]);
  return `${key}/claims/${contentVersion(encoder.encode(identity))}`;
}

async function claimAction(
  store: WorkflowEvalStore,
  key: string,
  kind: string,
  ...parts: string[]
) {
  return (
    await store.getOrSet(
      claimRecordKey(key, kind, ...parts),
      encoder.encode("claimed"),
    )
  ).created;
}

type WorkflowSubmissionPlan = Omit<
  WorkflowSubmissionRecord,
  "submissionData" | "externalId" | "status" | "completionMode"
>;

function plannedSubmissions(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  runId: string,
  caseIds: string[],
) {
  const stages: Array<{ kind: "task" | "score"; scorerName?: string }> = [];
  if (isWorkflowTask(definition.evaluator.task)) stages.push({ kind: "task" });
  for (const { name, scorer } of resolveScorers(
    definition.evaluator.scores ?? [],
  )) {
    if (isWorkflowScorer(scorer)) {
      stages.push({ kind: "score", scorerName: name });
    }
  }
  const plans: WorkflowSubmissionPlan[] = [];
  for (const { kind, scorerName } of stages) {
    for (const itemId of caseIds) {
      plans.push({
        id: deterministicId(stableStringify([runId, kind, scorerName, itemId])),
        kind,
        scorerName,
        itemId,
      });
    }
  }
  return plans;
}

async function readCaseRecord(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  store: WorkflowEvalStore,
  key: string,
  id: string,
) {
  const scorers = resolveScorers(definition.evaluator.scores ?? []);
  const classifiers = (definition.evaluator.classifiers ?? []).map(
    classifierName,
  );
  const [
    base,
    task,
    taskLog,
    scoreValues,
    scoreLogValues,
    classificationValues,
    classificationLogValues,
  ] = await Promise.all([
    readJson<WorkflowCaseBaseRecord>(store, caseRecordKey(key, id, "base")),
    readJson<WorkflowTaskResultRecord>(store, caseRecordKey(key, id, "task")),
    readJson<WorkflowTaskLogRecord>(store, caseRecordKey(key, id, "task-log")),
    Promise.all(
      scorers.map(async ({ name }) => ({
        name,
        value: await readJson<JsonValue>(
          store,
          caseRecordKey(key, id, "score", name),
        ),
      })),
    ),
    Promise.all(
      scorers.map(async ({ name }) => ({
        name,
        value: await readJson<true>(
          store,
          caseRecordKey(key, id, "score-log", name),
        ),
      })),
    ),
    Promise.all(
      classifiers.map(async (name) => ({
        name,
        value: await readJson<JsonValue>(
          store,
          caseRecordKey(key, id, "classification", name),
        ),
      })),
    ),
    Promise.all(
      classifiers.map(async (name) => ({
        name,
        value: await readJson<true>(
          store,
          caseRecordKey(key, id, "classification-log", name),
        ),
      })),
    ),
  ]);
  if (!base) throw new Error(`Workflow eval case ${id} is missing`);
  const scores: Record<string, JsonValue> = Object.create(null);
  for (const { name, value } of scoreValues) {
    if (value !== undefined) scores[name] = value;
  }
  const loggedScores: Record<string, boolean> = Object.create(null);
  for (const { name, value } of scoreLogValues) {
    if (value) loggedScores[name] = true;
  }
  const classifications: Record<string, JsonValue> = Object.create(null);
  for (const { name, value } of classificationValues) {
    if (value !== undefined) classifications[name] = value;
  }
  const loggedClassifications: Record<string, boolean> = Object.create(null);
  for (const { name, value } of classificationLogValues) {
    if (value) loggedClassifications[name] = true;
  }
  return {
    ...base,
    metadata: task?.metadata ?? base.metadata,
    tags: task ? task.tags : base.tags,
    taskComplete: task !== undefined,
    taskLogged: taskLog !== undefined,
    output: task?.output,
    rootSpan: taskLog?.rootSpan,
    scores,
    loggedScores,
    classifications,
    loggedClassifications,
  } satisfies WorkflowCaseRecord;
}

async function readRunState(
  definition: WorkflowEvalRuntimeDefinition<any, any, any, any, any>,
  store: WorkflowEvalStore,
  key: string,
  caseIds?: string[],
) {
  const record = await readJson<WorkflowRunRecord>(store, key);
  if (!record) return undefined;
  const selectedIds =
    caseIds ??
    (record.caseCount === 0
      ? []
      : await readJson<string[]>(store, `${key}/case-ids`));
  if (!selectedIds)
    throw new Error(`Workflow eval run ${record.runId} has no case index`);
  const plans = plannedSubmissions(definition, record.runId, selectedIds);
  const [cases, submissionRecords] = await Promise.all([
    Promise.all(
      selectedIds.map((id) => readCaseRecord(definition, store, key, id)),
    ),
    Promise.all(
      plans.map(async ({ id }) => {
        return readJson<WorkflowSubmissionRecord>(
          store,
          submissionRecordKey(key, id),
        );
      }),
    ),
  ]);
  const submissions = submissionRecords.filter(
    (value): value is WorkflowSubmissionRecord => value !== undefined,
  );
  return { ...record, cases, submissions };
}

async function writeRunRecord(
  store: WorkflowEvalStore,
  key: string,
  state: WorkflowRunState,
) {
  const { cases: _cases, submissions: _submissions, ...record } = state;
  await writeJson(store, key, record);
}

async function writeCaseBaseRecords(
  store: WorkflowEvalStore,
  key: string,
  records: WorkflowCaseRecord[],
) {
  await Promise.all(
    records.map(({ id, caseId, trialIndex, datum, metadata, tags }) =>
      writeJson(store, caseRecordKey(key, id, "base"), {
        id,
        caseId,
        trialIndex,
        datum,
        metadata,
        tags,
      } satisfies WorkflowCaseBaseRecord),
    ),
  );
}

async function writeCaseRecords(
  store: WorkflowEvalStore,
  key: string,
  records: WorkflowCaseRecord[],
) {
  const writes: Promise<void>[] = [];
  for (const record of records) {
    if (record.taskComplete) {
      writes.push(
        writeJson(store, caseRecordKey(key, record.id, "task"), {
          output: record.output,
          metadata: record.metadata,
          tags: record.tags,
          taskComplete: true,
        } satisfies WorkflowTaskResultRecord),
      );
    }
    if (record.taskLogged) {
      writes.push(
        writeJson(store, caseRecordKey(key, record.id, "task-log"), {
          rootSpan: record.rootSpan,
          taskLogged: true,
        } satisfies WorkflowTaskLogRecord),
      );
    }
    for (const [name, value] of Object.entries(record.scores)) {
      writes.push(
        writeJson(store, caseRecordKey(key, record.id, "score", name), value),
      );
    }
    for (const name of Object.keys(record.loggedScores)) {
      writes.push(
        writeJson(
          store,
          caseRecordKey(key, record.id, "score-log", name),
          true,
        ),
      );
    }
    for (const [name, value] of Object.entries(record.classifications)) {
      writes.push(
        writeJson(
          store,
          caseRecordKey(key, record.id, "classification", name),
          value,
        ),
      );
    }
    for (const name of Object.keys(record.loggedClassifications)) {
      writes.push(
        writeJson(
          store,
          caseRecordKey(key, record.id, "classification-log", name),
          true,
        ),
      );
    }
  }
  await Promise.all(writes);
}

async function writeSubmissionRecords(
  store: WorkflowEvalStore,
  key: string,
  records: WorkflowSubmissionRecord[],
) {
  await Promise.all(
    records.map(async (record) => {
      if (record.externalId !== undefined) {
        const locator = await store.getOrSet(
          `${key}/external/${encodedKeyPart(record.externalId)}`,
          encoder.encode(JSON.stringify(record.id)),
        );
        if (JSON.parse(decoder.decode(locator.value)) !== record.id) {
          throw new Error(`Duplicate externalId: ${record.externalId}`);
        }
      }
      const progressKey = `${key}/progress/${record.completionMode}`;
      await store.addToSet(`${progressKey}/submitted`, record.id);
      if (record.status === "complete") {
        await store.addToSet(`${progressKey}/complete`, record.id);
      }
      // Mark completion only after progress is saved, so polling can retry an
      // interrupted progress update instead of permanently skipping it.
      await writeJson(store, submissionRecordKey(key, record.id), record);
    }),
  );
}

function deterministicId(value: string) {
  const hex = contentVersion(encoder.encode(value))
    .padEnd(32, "0")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function contentVersion(value: Uint8Array) {
  if (iso.hash) return iso.hash(decoder.decode(value));
  let hash = 2166136261;
  for (const byte of value) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function readJson<T>(store: WorkflowEvalStore, key: string) {
  const value = await store.read(key);
  return value ? (JSON.parse(decoder.decode(value)) as T) : undefined;
}

async function writeJson(
  store: WorkflowEvalStore,
  key: string,
  value: unknown,
) {
  await store.write(key, encoder.encode(stableStringify(value)));
}

function stableStringify(value: unknown) {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }
    return nested;
  });
}

function assertJsonValue(value: unknown, label: string): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new Error("value serializes to undefined");
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new Error(`${label} must be JSON serializable`, { cause: error });
  }
}

function isWorkflowTask(
  value: unknown,
): value is WorkflowTaskDefinition<any, any, any, any, any, JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === WORKFLOW_TASK_KIND
  );
}

function isWorkflowScorer(
  value: unknown,
): value is WorkflowScorerDefinition<any, any, any, any, JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === WORKFLOW_SCORER_KIND
  );
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
