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
const BATCH_TASK_KIND = "braintrust.durable.batch-task";
const BATCH_SCORER_KIND = "braintrust.durable.batch-scorer";
const DEFAULT_BATCH_SIZE = 1_000;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Minimal persistence used to reconnect provider webhooks with submitted
 * batches. Each run, case, and batch is stored under its own key. Durable
 * evaluations do not require any Braintrust backend changes.
 *
 * @experimental - The API for this interface is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export interface DurableEvalStore {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
  /** Atomically stores `value` when `key` is absent and returns its stored value. */
  getOrSet(
    key: string,
    value: Uint8Array,
  ): Promise<{ value: Uint8Array; created: boolean }>;
}

/**
 * Stores durable evaluation state in memory. State is lost when the current
 * JavaScript process exits.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class DurableEvalMemoryStore implements DurableEvalStore {
  private readonly values = new Map<string, Uint8Array>();

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
}

/**
 * Stores durable evaluation state in Redis using an existing Redis client.
 * Values are base64 encoded so only string `GET` and `SET` operations are
 * required from the client. Clients from `redis` (node-redis), `ioredis`, and
 * `@upstash/redis` can be passed directly.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class DurableEvalRedisStore implements DurableEvalStore {
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
      throw new Error("DurableEvalRedisStore ttlMs must be a positive integer");
    }
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    const value = await this.client.get(`${this.keyPrefix}${key}`);
    if (value == null) return undefined;
    if (typeof value !== "string") {
      throw new Error("DurableEvalRedisStore expected GET to return a string");
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
        "DurableEvalRedisStore requires a node-redis, ioredis, or @upstash/redis client",
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
        "DurableEvalRedisStore getOrSet requires a node-redis, ioredis, or @upstash/redis client",
      );
    }
    const existing = await set.call(client, redisKey, encoded, ...setOptions);
    if (existing === null) return { value: value.slice(), created: true };
    if (typeof existing !== "string") {
      throw new Error(
        "DurableEvalRedisStore expected atomic SET to return a string or null",
      );
    }
    return { value: base64ToUint8Array(existing), created: false };
  }
}

interface DurableBatchContext {
  runId: string;
  batchId: string;
}

type DurableBatchPoll =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "failed"; error: unknown };

type DurableBatchCompletion<SubmissionData extends JsonValue> =
  | {
      mode: "poll";
      /** Checks whether the submitted provider batch is ready to collect. */
      poll(
        submissionData: SubmissionData,
        context: DurableBatchContext,
      ): Promise<DurableBatchPoll>;
    }
  | {
      mode: "webhook";
      /** Returns the provider ID used to match an incoming webhook to this batch. */
      getExternalId(
        submissionData: SubmissionData,
        context: DurableBatchContext,
      ): string;
    };

export interface DurableBatchTaskItem<
  Input,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
> {
  /** Stable identifier for this case and trial within the durable run. */
  id: string;
  /** Input value from the evaluation case. */
  input: Input;
  /** Expected value from the evaluation case. */
  expected: Expected;
  /** Metadata associated with the evaluation case. */
  metadata: Metadata;
  /** Tags associated with the evaluation case. */
  tags: string[] | undefined;
  /** Parameters supplied when the durable evaluation started. */
  parameters: InferParameters<Parameters>;
  /** Zero-based trial index for this case. */
  trialIndex: number;
}

type DurableBatchTaskResult<Output, Metadata extends BaseMetadata> = {
  /** ID of the submitted item this result belongs to. */
  id: string;
  /** Task output for the item. */
  output: Output;
  /** Metadata to merge into the evaluation case. */
  metadata?: Metadata;
  /** Tags to replace those from the evaluation case. */
  tags?: string[];
};

export type DurableBatchScorerItem<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
> = EvalScorerArgs<Input, Output, Expected, Metadata> & {
  /** Stable identifier for this case and trial within the durable run. */
  id: string;
  /** Zero-based trial index for this case. */
  trialIndex: number;
};

type DurableBatchScorerResult = {
  /** ID of the submitted item this result belongs to. */
  id: string;
  /** Score or named scores produced for the item. */
  score: OneOrMoreScores;
};

interface DurableBatchProcessor<
  Item,
  Result,
  SubmissionData extends JsonValue,
> {
  /** Maximum items submitted in one provider batch. Defaults to 1,000. */
  batchSize?: number;
  /** Submits a batch and returns the provider-specific submission data. */
  submit(items: Item[], context: DurableBatchContext): Promise<SubmissionData>;
  /** Configures how the SDK learns that the submitted batch completed. */
  completion: DurableBatchCompletion<SubmissionData>;
  /** Collects one result for every item in a completed provider batch. */
  collect(
    submissionData: SubmissionData,
    context: DurableBatchContext,
  ): Promise<Result[]>;
}

interface DurableBatchTask<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
  SubmissionData extends JsonValue,
> {
  readonly kind: typeof BATCH_TASK_KIND;
  readonly processor: DurableBatchProcessor<
    DurableBatchTaskItem<Input, Expected, Metadata, Parameters>,
    DurableBatchTaskResult<Output, Metadata>,
    SubmissionData
  >;
}

interface DurableBatchScorer<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  SubmissionData extends JsonValue,
> {
  readonly kind: typeof BATCH_SCORER_KIND;
  name: string;
  readonly processor: DurableBatchProcessor<
    DurableBatchScorerItem<Input, Output, Expected, Metadata>,
    DurableBatchScorerResult,
    SubmissionData
  >;
}

/**
 * Defines a task that runs through asynchronous provider batch operations.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class BatchTask<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
  SubmissionData extends JsonValue = JsonValue,
> implements DurableBatchTask<
  Input,
  Output,
  Expected,
  Metadata,
  Parameters,
  SubmissionData
> {
  readonly kind: typeof BATCH_TASK_KIND = BATCH_TASK_KIND;

  constructor(
    readonly processor: DurableBatchProcessor<
      DurableBatchTaskItem<Input, Expected, Metadata, Parameters>,
      DurableBatchTaskResult<Output, Metadata>,
      SubmissionData
    >,
  ) {}
}

/**
 * Defines a scorer that runs through asynchronous provider batch operations.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class BatchScorer<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  SubmissionData extends JsonValue = JsonValue,
> implements DurableBatchScorer<
  Input,
  Output,
  Expected,
  Metadata,
  SubmissionData
> {
  readonly kind: typeof BATCH_SCORER_KIND = BATCH_SCORER_KIND;
  readonly name: string;

  constructor(
    readonly processor: DurableBatchProcessor<
      DurableBatchScorerItem<Input, Output, Expected, Metadata>,
      DurableBatchScorerResult,
      SubmissionData
    > & { name: string },
  ) {
    this.name = processor.name;
  }
}

type DurableEvaluator<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> = Omit<
  Evaluator<Input, Output, Expected, Metadata, Parameters>,
  "task" | "scores" | "timeout" | "signal" | "maxConcurrency" | "update"
> & {
  store: DurableEvalStore;
  /**
   * Returns a stable case ID when a data item has neither `id` nor `upsert_id`.
   * The ID is shared by all trials of the same case.
   */
  caseId?: (
    datum: EvalCase<Input, Expected, Metadata>,
  ) => string | Promise<string>;
  task:
    | EvalTask<Input, Output, Expected, Metadata, Parameters>
    | DurableBatchTask<
        Input,
        Output,
        Expected,
        Metadata,
        Parameters,
        JsonValue
      >;
  scores?: Array<
    | EvalScorer<Input, Output, Expected, Metadata>
    | DurableBatchScorer<Input, Output, Expected, Metadata, JsonValue>
  >;
};

interface DurableEvalStartOptions<
  Parameters extends EvalParameters = EvalParameters,
> {
  parameters?: InferParameters<Parameters>;
  noSendLogs?: boolean;
}

type DurableBatchResult = {
  runId: string;
  batchId?: string;
  externalId?: string;
};

type DurableEvalResult =
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

interface DurableEvalRuntimeDefinition<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> {
  readonly projectName: string;
  readonly evalName: string;
  readonly evaluator: DurableEvaluator<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >;
}

interface DurableEvalDefinition<Parameters extends EvalParameters> {
  start(
    options?: DurableEvalStartOptions<Parameters>,
  ): Promise<DurableEvalResult>;
  status(options: { runId: string }): Promise<DurableEvalResult>;
  poll(options: { runId: string }): Promise<DurableEvalResult>;
  processBatchResult(result: DurableBatchResult): Promise<DurableEvalResult>;
}

type DurableCaseRecord = {
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

type DurableCaseBaseRecord = Pick<
  DurableCaseRecord,
  "id" | "caseId" | "trialIndex" | "datum" | "metadata" | "tags"
>;

type DurableTaskResultRecord = Pick<
  DurableCaseRecord,
  "output" | "metadata" | "tags"
> & { taskComplete: true };

type DurableTaskLogRecord = Pick<DurableCaseRecord, "rootSpan"> & {
  taskLogged: true;
};

type DurableBatchRecord = {
  id: string;
  kind: "task" | "score";
  scorerName?: string;
  itemIds: string[];
  submissionData: JsonValue;
  externalId?: string;
  status: "submitted" | "complete";
};

type DurableRunState = {
  runId: string;
  experimentName: string;
  noSendLogs: boolean;
  parameters: JsonValue;
  status: "running" | "completed";
  summary?: ExperimentSummary;
  cases: DurableCaseRecord[];
  batches: DurableBatchRecord[];
};

type DurableRunRecord = Omit<DurableRunState, "cases" | "batches"> & {
  caseIds: string[];
};

/*
 * Internal usage notes. Keep these out of the public README while
 * defineDurableEval() is experimental.
 *
 * ## Durable evaluations
 *
 * `defineDurableEval()` runs tasks and scorers through asynchronous provider
 * batch APIs.
 * `batchSize` splits a dataset into provider-sized sub-batches. A small external
 * store connects submitted jobs with later webhook callbacks; it is required on
 * the eval definition so every invocation uses the same persistence authority.
 * No Braintrust backend changes are required.
 *
 * Every case needs a stable `id` (or a `caseId` function).
 *
 * For local or single-process runs, use the built-in memory store. For durable
 * deployments, the Redis adapter accepts any existing client with asynchronous
 * `get(key)` and `set(key, value)` methods. The adapter itself adds no Redis
 * dependency, so install and configure whichever client your application already
 * uses.
 *
 * The following popular clients can be passed directly to
 * `DurableEvalRedisStore`:
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
 * import { DurableEvalRedisStore } from "braintrust";
 *
 * const nodeRedis = await createClient({ url: process.env.REDIS_URL! }).connect();
 * const redisStore = new DurableEvalRedisStore({ client: nodeRedis });
 * ```
 *
 * ioredis:
 *
 * ```typescript
 * import Redis from "ioredis";
 * import { DurableEvalRedisStore } from "braintrust";
 *
 * const ioRedis = new Redis(process.env.REDIS_URL!);
 * const redisStore = new DurableEvalRedisStore({ client: ioRedis });
 * ```
 *
 * Upstash:
 *
 * ```typescript
 * import { Redis } from "@upstash/redis";
 * import { DurableEvalRedisStore } from "braintrust";
 *
 * const upstashRedis = Redis.fromEnv();
 * const redisStore = new DurableEvalRedisStore({ client: upstashRedis });
 * ```
 *
 * Redis entries expire after seven days by default. Set `ttlMs` in the store
 * options to use a different lifetime. For local testing,
 * `new DurableEvalMemoryStore()` requires no external client, but is
 * process-local and loses its state when the process exits, so it should not be
 * used to reconnect webhooks across serverless invocations.
 *
 * ```typescript
 * import { BatchTask, defineDurableEval } from "braintrust";
 *
 * const supportEval = defineDurableEval("Support bot", {
 *   store: redisStore,
 *   data: [
 *     {
 *       id: "password-reset",
 *       input: "How do I reset my password?",
 *       expected: "Open account settings...",
 *     },
 *   ],
 *   task: new BatchTask({
 *     // Each provider job contains at most 500 eval cases.
 *     batchSize: 500,
 *
 *     // Submit one sub-batch and return JSON-serializable submission data.
 *     async submit(items, context) {
 *       const batch = await provider.submit({
 *         idempotencyKey: context.batchId,
 *         metadata: {
 *           durableRunId: context.runId,
 *           durableBatchId: context.batchId,
 *         },
 *         items,
 *       });
 *       return { id: batch.id };
 *     },
 *
 *     completion: {
 *       // "webhook" waits for processBatchResult(). Use "poll" with a poll()
 *       // callback when the provider does not send completion events.
 *       mode: "webhook",
 *       getExternalId: (submissionData) => submissionData.id,
 *     },
 *
 *     async collect(submissionData) {
 *       return (await provider.results(submissionData.id)).map((item) => ({
 *         id: item.id,
 *         output: item.output,
 *       }));
 *     },
 *   }),
 *   scores: [
 *     function exact({ output, expected }) {
 *       return output === expected ? 1 : 0;
 *     },
 *   ],
 * });
 *
 * const result = await supportEval.start();
 * const { runId } = result;
 * ```
 *
 * `start()` initializes the run, submits every ready task sub-batch, and returns.
 * It never waits in a polling loop. When all task results are available, scoring
 * begins. `BatchScorer` uses the same `batchSize`, `submit`, `completion`, and
 * array-returning `collect` contract.
 *
 * ### Polling
 *
 * Polling adapters report the provider's current status through `completion`:
 *
 * ```typescript
 * completion: {
 *   mode: "poll",
 *   async poll(submissionData) {
 *     const batch = await provider.getBatch(submissionData.id);
 *     if (batch.status === "completed") return { status: "complete" };
 *     if (batch.status === "failed") {
 *       return { status: "failed", error: batch.error };
 *     }
 *     return { status: "pending" };
 *   },
 * },
 * ```
 *
 * Call `poll()` from a cron, queue worker, or another short-lived invocation. It
 * checks every previously submitted polling batch once, collects completed
 * results, submits newly ready work, and returns without sleeping:
 *
 * ```typescript
 * const result = await supportEval.poll({
 *   runId,
 * });
 *
 * if (result.status === "waiting" && result.pending.poll > 0) {
 *   scheduleAnotherPoll();
 * }
 * ```
 *
 * `start()`, `poll()`, and `processBatchResult()` return the current eval status.
 * A waiting result includes the number of submitted batches using each completion
 * mode:
 *
 * ```typescript
 * {
 *   status: "waiting",
 *   runId,
 *   pending: { poll: 2, webhook: 1 },
 * }
 * ```
 *
 * Use `status()` to read the same information without polling providers,
 * collecting results, or advancing the evaluation:
 *
 * ```typescript
 * const status = await supportEval.status({
 *   runId,
 * });
 * ```
 *
 * Completed statuses have zero pending batches and include the saved experiment
 * summary. They can be read repeatedly without logging the eval again.
 *
 * ### Webhook processing
 *
 * When the provider reports that any task or scorer batch completed, fetch and
 * store its results through `processBatchResult()`:
 *
 * ```typescript
 * app.post("/webhooks/provider", async (request, response) => {
 *   const event = request.body;
 *   const batch = await provider.getBatch(event.batchId);
 *   const runId = batch.metadata.durableRunId;
 *
 *   const result = await supportEval.processBatchResult({
 *     // Returned by start() and saved alongside the provider job.
 *     runId,
 *     // The provider's batch ID. The durable eval saved it from submit()'s result.
 *     externalId: batch.id,
 *     // The SDK-generated ID passed to submit(); include it in provider metadata
 *     // when the webhook cannot provide the external ID used by the submission data.
 *     batchId: batch.metadata?.durableBatchId,
 *   });
 *
 *   response.status(result.status === "waiting" ? 202 : 200).end();
 * });
 * ```
 *
 * The method accepts either `externalId` or `batchId`. The stored batch locator
 * identifies the task or scorer batch, whose `collect()` results are stored
 * before the eval advances. Provider failure handling remains the application's
 * responsibility for now.
 */

/**
 * Defines a durable evaluation backed by a user-provided store.
 *
 * @experimental - The API for this function is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export function defineDurableEval<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
>(
  projectName: string,
  evaluator: DurableEvaluator<Input, Output, Expected, Metadata, Parameters>,
): DurableEvalDefinition<Parameters> {
  const definition: DurableEvalRuntimeDefinition<
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
    start: (options = {}) => startDurableEval(definition, options),
    status: (options) => getDurableEvalStatus(definition, options),
    poll: (options) => pollDurableEval(definition, options),
    processBatchResult: (result) =>
      processDurableBatchResult(definition, result),
  };
}

async function startDurableEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  options: DurableEvalStartOptions<Parameters>,
): Promise<DurableEvalResult> {
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
    !isBatchTask(definition.evaluator.task) &&
    !(definition.evaluator.scores ?? []).some(isBatchScorer)
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
    const state: DurableRunState = {
      runId,
      experimentName,
      noSendLogs: options.noSendLogs ?? false,
      parameters: assertJsonValue(parameters, "eval parameters"),
      status: "completed",
      summary: result.summary,
      cases: [],
      batches: [],
    };
    await experiment?.flush();
    await writeRunRecord(store, key, state);
    return currentStatus(definition, state);
  }
  const state: DurableRunState = {
    runId,
    experimentName,
    noSendLogs: options.noSendLogs ?? false,
    parameters: assertJsonValue(parameters, "eval parameters"),
    status: "running",
    cases: await materializeCases(definition, data, experiment),
    batches: [],
  };
  await writeCaseBaseRecords(store, key, state.cases);
  await writeRunRecord(store, key, state);
  return advanceDurableEval(definition, state, store, key, experiment);
}

async function getDurableEvalStatus<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  options: { runId: string },
): Promise<DurableEvalResult> {
  const store = definition.evaluator.store;
  const state = await readRunState(
    definition,
    store,
    runKey(definition.projectName, definition.evalName, options.runId),
  );
  if (!state) throw new Error(`Durable eval run ${options.runId} is missing`);
  return currentStatus(definition, state);
}

async function processDurableBatchResult<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  result: DurableBatchResult,
): Promise<DurableEvalResult> {
  if (!result.batchId && !result.externalId) {
    throw new Error("Batch results require batchId or externalId");
  }
  const store = definition.evaluator.store;
  const key = runKey(definition.projectName, definition.evalName, result.runId);
  const state = await readRunState(definition, store, key);
  if (!state) throw new Error(`Durable eval run ${result.runId} is missing`);
  const byBatch = result.batchId
    ? state.batches.find((candidate) => candidate.id === result.batchId)
    : undefined;
  const byExternal = result.externalId
    ? state.batches.find(
        (candidate) => candidate.externalId === result.externalId,
      )
    : undefined;
  if (byBatch && byExternal && byBatch.id !== byExternal.id) {
    throw new Error("batchId and externalId identify different batches");
  }
  const batch = byBatch ?? byExternal;
  if (!batch) throw new Error("No submitted batch matches this result");
  if (batch.status !== "complete") {
    const records = await collectBatch(definition, state, batch);
    batch.status = "complete";
    await writeCaseRecords(store, key, records);
    await writeBatchRecords(store, key, [batch]);
  }
  return advanceDurableEval(
    definition,
    (await readRunState(definition, store, key))!,
    store,
    key,
  );
}

async function pollDurableEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  options: { runId: string },
): Promise<DurableEvalResult> {
  const store = definition.evaluator.store;
  const key = runKey(
    definition.projectName,
    definition.evalName,
    options.runId,
  );
  const state = await readRunState(definition, store, key);
  if (!state) throw new Error(`Durable eval run ${options.runId} is missing`);

  const batches = state.batches.filter((batch) => {
    if (batch.status === "complete") return false;
    return (
      processorForStage(definition, batch.kind, batch.scorerName).completion
        .mode === "poll"
    );
  });
  const results = await Promise.all(
    batches.map(async (batch) => ({
      batch,
      result: await (
        processorForStage(definition, batch.kind, batch.scorerName)
          .completion as Extract<
          DurableBatchCompletion<JsonValue>,
          { mode: "poll" }
        >
      ).poll(batch.submissionData, {
        runId: state.runId,
        batchId: batch.id,
      }),
    })),
  );
  const changedCases = new Map<string, DurableCaseRecord>();
  const changedBatches: DurableBatchRecord[] = [];
  for (const { batch, result } of results) {
    if (result.status === "failed") throw asError(result.error);
    if (result.status !== "complete") continue;
    for (const record of await collectBatch(definition, state, batch)) {
      changedCases.set(record.id, record);
    }
    batch.status = "complete";
    changedBatches.push(batch);
  }
  if (changedBatches.length > 0) {
    await writeCaseRecords(store, key, [...changedCases.values()]);
    await writeBatchRecords(store, key, changedBatches);
  }
  const currentState =
    changedBatches.length > 0
      ? (await readRunState(definition, store, key))!
      : state;
  return advanceDurableEval(definition, currentState, store, key);
}

async function openDurableExperiment(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
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

async function advanceDurableEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  state: DurableRunState,
  store: DurableEvalStore,
  key: string,
  existingExperiment?: Experiment | null,
): Promise<DurableEvalResult> {
  if (state.status === "completed") return currentStatus(definition, state);
  const experiment =
    existingExperiment === undefined
      ? await openDurableExperiment(definition, state)
      : existingExperiment;
  await runTaskStage(definition, state, store, key, experiment);
  await logCompletedTasks(definition, state, store, key, experiment);
  state = (await readRunState(definition, store, key)) ?? state;
  if (
    state.cases.some((record) => !record.taskComplete || !record.taskLogged)
  ) {
    return currentStatus(definition, state);
  }

  await runScoreStages(definition, state, store, key, experiment);
  state = (await readRunState(definition, store, key)) ?? state;
  const scorerNames = resolveScorers(definition.evaluator.scores ?? []).map(
    ({ name }) => name,
  );
  const classifierNames = (definition.evaluator.classifiers ?? []).map(
    classifierName,
  );
  if (
    state.cases.some(
      (record) =>
        scorerNames.some(
          (name) =>
            !Object.hasOwn(record.scores, name) ||
            !Object.hasOwn(record.loggedScores, name),
        ) ||
        classifierNames.some(
          (name) => !Object.hasOwn(record.loggedClassifications, name),
        ),
    )
  ) {
    return currentStatus(definition, state);
  }

  if (!(await claimAction(store, key, "finish"))) {
    const latest = await readRunState(definition, store, key);
    return currentStatus(definition, latest ?? state);
  }
  state.summary = await finishExperiment(definition, state, experiment);
  state.status = "completed";
  await writeRunRecord(store, key, state);
  return currentStatus(definition, state);
}

function currentStatus(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
): DurableEvalResult {
  if (state.status === "completed") {
    if (!state.summary) {
      throw new Error(`Durable eval run ${state.runId} has no saved summary`);
    }
    return {
      status: "completed",
      runId: state.runId,
      pending: { poll: 0, webhook: 0 },
      summary: state.summary,
    };
  }
  const pending = { poll: 0, webhook: 0 };
  for (const batch of state.batches) {
    if (batch.status === "complete") continue;
    pending[
      processorForStage(definition, batch.kind, batch.scorerName).completion
        .mode
    ]++;
  }
  return { status: "waiting", runId: state.runId, pending };
}

async function startCaseRoot(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
  record: DurableCaseRecord,
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
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
  record: DurableCaseRecord,
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
        durable_eval: {
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
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
  store: DurableEvalStore,
  key: string,
  experiment: Experiment | null,
) {
  const changed: DurableCaseRecord[] = [];
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
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  state: DurableRunState,
  store: DurableEvalStore,
  key: string,
  experiment: Experiment | null,
) {
  if (isBatchTask(definition.evaluator.task)) {
    await ensureBatches(definition, state, store, key, "task");
    return;
  }

  const task = definition.evaluator.task as EvalTask<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >;
  const changed: DurableCaseRecord[] = [];
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
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  state: DurableRunState,
  store: DurableEvalStore,
  key: string,
  experiment: Experiment | null,
) {
  const scorers = resolveScorers(definition.evaluator.scores ?? []);
  const changed = new Map<string, DurableCaseRecord>();
  const persistChangedCases = async () => {
    if (changed.size === 0) return;
    await experiment?.flush();
    await writeCaseRecords(store, key, [...changed.values()]);
    changed.clear();
  };
  for (const { name, scorer } of scorers) {
    if (isBatchScorer(scorer)) {
      for (const record of state.cases) {
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
      await ensureBatches(definition, state, store, key, "score", name);
      continue;
    }
    for (const record of state.cases) {
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

function scorerArgs(record: DurableCaseRecord) {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  return {
    ...datum,
    metadata: record.metadata,
    output: record.output,
  } as EvalScorerArgs<unknown, unknown, unknown, BaseMetadata>;
}

function resumeCaseRoot(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  record: DurableCaseRecord,
  experiment: Experiment | null,
) {
  if (!experiment) return NOOP_SPAN;
  if (!record.rootSpan) {
    throw new Error(`Durable eval case ${record.caseId} has no root span`);
  }
  return _internalResumeSpan({
    exported: record.rootSpan,
    state: definition.evaluator.state,
  });
}

async function evaluateAndLogScore(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
  record: DurableCaseRecord,
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
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
  record: DurableCaseRecord,
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

async function ensureBatches(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
  store: DurableEvalStore,
  key: string,
  kind: "task" | "score",
  scorerName?: string,
) {
  const processor = processorForStage(definition, kind, scorerName);
  const plans = plannedBatches(
    definition,
    state.runId,
    state.cases.map(({ id }) => id),
  );
  const casesById = new Map(state.cases.map((record) => [record.id, record]));
  for (const plan of plans) {
    if (plan.kind !== kind || plan.scorerName !== scorerName) continue;
    if (state.batches.some(({ id }) => id === plan.id)) continue;
    const records = plan.itemIds.map((id) => casesById.get(id)!);
    const ready = records.every((record) =>
      kind === "task"
        ? !record.taskComplete
        : !Object.hasOwn(record.scores, scorerName!),
    );
    if (!ready) continue;
    const batchId = plan.id;
    const claim = await store.getOrSet(
      claimRecordKey(key, "batch", batchId),
      encoder.encode(batchId),
    );
    if (!claim.created) continue;
    const context = { runId: state.runId, batchId };
    const items = records.map((record) =>
      kind === "task"
        ? taskBatchItem(record, state.parameters)
        : scorerBatchItem(record),
    );
    const submissionData = assertJsonValue(
      await processor.submit(items, context),
      `submission data for batch ${batchId}`,
    );
    const externalId =
      processor.completion.mode === "webhook"
        ? processor.completion.getExternalId(submissionData, context)
        : undefined;
    if (externalId !== undefined && !externalId.trim()) {
      throw new Error(`Batch ${batchId} produced an empty externalId`);
    }
    const batch: DurableBatchRecord = {
      id: batchId,
      kind,
      scorerName,
      itemIds: records.map((record) => record.id),
      submissionData,
      externalId,
      status: "submitted",
    };
    state.batches.push(batch);
    await writeBatchRecords(store, key, [batch]);
  }
}

async function collectBatch(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
  batch: DurableBatchRecord,
) {
  const processor = processorForStage(definition, batch.kind, batch.scorerName);
  const context = { runId: state.runId, batchId: batch.id };
  const results = await processor.collect(batch.submissionData, context);
  if (!Array.isArray(results)) {
    throw new Error(`collect for batch ${batch.id} must return an array`);
  }
  const expectedIds = new Set(batch.itemIds);
  const seen = new Set<string>();
  const records: DurableCaseRecord[] = [];
  for (const result of results) {
    const id = resultItemId(result);
    if (!expectedIds.has(id)) {
      throw new Error(`Batch ${batch.id} returned unknown item ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Batch ${batch.id} returned item ${id} more than once`);
    }
    seen.add(id);
    const record = state.cases.find((candidate) => candidate.id === id)!;
    records.push(record);
    if (batch.kind === "task") {
      record.output = assertJsonValue(
        result.output,
        `task output for item ${id}`,
      );
      if ("metadata" in result && result.metadata !== undefined) {
        record.metadata = assertJsonValue(
          {
            ...(record.metadata as Record<string, unknown>),
            ...result.metadata,
          },
          `metadata for ${id}`,
        );
      }
      if ("tags" in result && result.tags !== undefined)
        record.tags = result.tags;
      record.taskComplete = true;
    } else {
      record.scores[batch.scorerName!] = assertJsonValue(
        result.score,
        `score output for item ${id}`,
      );
    }
  }
  const missing = batch.itemIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Batch ${batch.id} did not return results for: ${missing.join(", ")}`,
    );
  }
  return records;
}

function processorForStage(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  kind: "task" | "score",
  scorerName?: string,
): DurableBatchProcessor<any, any, JsonValue> {
  if (kind === "task") {
    if (!isBatchTask(definition.evaluator.task)) {
      throw new Error("Definition no longer contains the batch task");
    }
    return definition.evaluator.task.processor as DurableBatchProcessor<
      any,
      any,
      JsonValue
    >;
  }
  const scorer = resolveScorers(definition.evaluator.scores ?? []).find(
    ({ name }) => name === scorerName,
  )?.scorer;
  if (!isBatchScorer(scorer)) {
    throw new Error(`Definition no longer contains scorer ${scorerName}`);
  }
  return scorer.processor as DurableBatchProcessor<any, any, JsonValue>;
}

async function materializeCases<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalRuntimeDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  data: Evaluator<Input, Output, Expected, Metadata, Parameters>["data"],
  experiment: Experiment | null,
): Promise<DurableCaseRecord[]> {
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
  const records: DurableCaseRecord[] = [];
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
        "Every durable eval case requires id, upsert_id, or caseId",
      );
    }
    if (seen.has(caseId))
      throw new Error(`Duplicate durable eval case id: ${caseId}`);
    seen.add(caseId);
    const trialCount = datum.trialCount ?? evaluator.trialCount ?? 1;
    if (!Number.isInteger(trialCount) || trialCount < 1) {
      throw new Error(`Invalid trialCount for durable eval case ${caseId}`);
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

function taskBatchItem(record: DurableCaseRecord, parameters: JsonValue) {
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

function scorerBatchItem(record: DurableCaseRecord) {
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
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  state: DurableRunState,
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
    | DurableBatchScorer<any, any, any, any, JsonValue>
  >,
) {
  return scorers.map((scorer, index) => ({
    name: isBatchScorer(scorer)
      ? scorer.name
      : scorer.name || `scorer_${index}`,
    scorer,
  }));
}

function runKey(projectName: string, evalName: string, runId: string) {
  return `durable-eval/v1/runs/${contentVersion(encoder.encode(`${projectName}\0${evalName}\0${runId}`))}`;
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

function batchRecordKey(key: string, batchId: string) {
  return `${key}/batches/${encodedKeyPart(batchId)}`;
}

function claimRecordKey(key: string, kind: string, ...parts: string[]) {
  const identity = stableStringify([kind, parts]);
  return `${key}/claims/${contentVersion(encoder.encode(identity))}`;
}

async function claimAction(
  store: DurableEvalStore,
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

type DurableBatchPlan = Omit<
  DurableBatchRecord,
  "submissionData" | "externalId" | "status"
>;

function plannedBatches(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  runId: string,
  caseIds: string[],
) {
  const stages: Array<{ kind: "task" | "score"; scorerName?: string }> = [];
  if (isBatchTask(definition.evaluator.task)) stages.push({ kind: "task" });
  for (const { name, scorer } of resolveScorers(
    definition.evaluator.scores ?? [],
  )) {
    if (isBatchScorer(scorer)) {
      stages.push({ kind: "score", scorerName: name });
    }
  }
  const plans: DurableBatchPlan[] = [];
  for (const { kind, scorerName } of stages) {
    const batchSize =
      processorForStage(definition, kind, scorerName).batchSize ??
      DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        `Invalid batchSize for ${scorerName ?? "task"}: ${batchSize}`,
      );
    }
    for (let offset = 0; offset < caseIds.length; offset += batchSize) {
      const itemIds = caseIds.slice(offset, offset + batchSize);
      plans.push({
        id: deterministicId(
          stableStringify([runId, kind, scorerName, itemIds]),
        ),
        kind,
        scorerName,
        itemIds,
      });
    }
  }
  return plans;
}

async function readCaseRecord(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  store: DurableEvalStore,
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
    readJson<DurableCaseBaseRecord>(store, caseRecordKey(key, id, "base")),
    readJson<DurableTaskResultRecord>(store, caseRecordKey(key, id, "task")),
    readJson<DurableTaskLogRecord>(store, caseRecordKey(key, id, "task-log")),
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
  if (!base) throw new Error(`Durable eval case ${id} is missing`);
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
  } satisfies DurableCaseRecord;
}

async function readRunState(
  definition: DurableEvalRuntimeDefinition<any, any, any, any, any>,
  store: DurableEvalStore,
  key: string,
) {
  const record = await readJson<DurableRunRecord>(store, key);
  if (!record) return undefined;
  const plans = plannedBatches(definition, record.runId, record.caseIds);
  const [cases, batchRecords] = await Promise.all([
    Promise.all(
      record.caseIds.map((id) => readCaseRecord(definition, store, key, id)),
    ),
    Promise.all(
      plans.map(async ({ id }) => {
        return readJson<DurableBatchRecord>(store, batchRecordKey(key, id));
      }),
    ),
  ]);
  const batches = batchRecords.filter(
    (value): value is DurableBatchRecord => value !== undefined,
  );
  const { caseIds: _caseIds, ...state } = record;
  return { ...state, cases, batches };
}

async function writeRunRecord(
  store: DurableEvalStore,
  key: string,
  state: DurableRunState,
) {
  const { cases, batches: _batches, ...record } = state;
  await writeJson(store, key, {
    ...record,
    caseIds: cases.map(({ id }) => id),
  } satisfies DurableRunRecord);
}

async function writeCaseBaseRecords(
  store: DurableEvalStore,
  key: string,
  records: DurableCaseRecord[],
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
      } satisfies DurableCaseBaseRecord),
    ),
  );
}

async function writeCaseRecords(
  store: DurableEvalStore,
  key: string,
  records: DurableCaseRecord[],
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
        } satisfies DurableTaskResultRecord),
      );
    }
    if (record.taskLogged) {
      writes.push(
        writeJson(store, caseRecordKey(key, record.id, "task-log"), {
          rootSpan: record.rootSpan,
          taskLogged: true,
        } satisfies DurableTaskLogRecord),
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

async function writeBatchRecords(
  store: DurableEvalStore,
  key: string,
  records: DurableBatchRecord[],
) {
  await Promise.all(
    records.map((record) =>
      writeJson(store, batchRecordKey(key, record.id), record),
    ),
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

async function readJson<T>(store: DurableEvalStore, key: string) {
  const value = await store.read(key);
  return value ? (JSON.parse(decoder.decode(value)) as T) : undefined;
}

async function writeJson(store: DurableEvalStore, key: string, value: unknown) {
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

function resultItemId(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("Batch results must contain a string id");
  }
  return value.id;
}

function isBatchTask(
  value: unknown,
): value is DurableBatchTask<any, any, any, any, any, JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === BATCH_TASK_KIND
  );
}

function isBatchScorer(
  value: unknown,
): value is DurableBatchScorer<any, any, any, any, JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === BATCH_SCORER_KIND
  );
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
