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
const CHECKPOINT_VERSION = 2;
const DEFAULT_BATCH_SIZE = 1_000;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Minimal persistence used to reconnect provider webhooks with submitted
 * batches. Durable evaluations do not require any Braintrust backend changes.
 *
 * @experimental - The API for this interface is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export interface DurableEvalStore {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
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
}

/**
 * Stores durable evaluation state in Redis using an existing Redis client.
 * Values are base64 encoded so only string `GET` and `SET` operations are
 * required from the client. Clients from `redis` (node-redis), `ioredis`, and
 * `@upstash/redis` can be passed directly; other clients with compatible async
 * `get` and `set` methods are also supported.
 *
 * @experimental - The API for this class is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export class DurableEvalRedisStore implements DurableEvalStore {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: {
      get(key: string): Promise<unknown>;
      set(key: string, value: string): Promise<unknown>;
    },
    options: { keyPrefix?: string } = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? "braintrust:";
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
    await this.client.set(`${this.keyPrefix}${key}`, uint8ArrayToBase64(value));
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

type DurableBatchCompletion<Handle extends JsonValue> =
  | {
      mode: "poll";
      poll(
        handle: Handle,
        context: DurableBatchContext,
      ): Promise<DurableBatchPoll>;
    }
  | {
      mode: "webhook";
      externalId(handle: Handle, context: DurableBatchContext): string;
    };

export interface DurableBatchTaskItem<
  Input,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
> {
  id: string;
  input: Input;
  expected: Expected;
  metadata: Metadata;
  tags: string[] | undefined;
  parameters: InferParameters<Parameters>;
  trialIndex: number;
}

type DurableBatchTaskResult<Output, Metadata extends BaseMetadata> =
  | {
      id: string;
      output: Output;
      metadata?: Metadata;
      tags?: string[];
    }
  | { id: string; error: unknown };

export type DurableBatchScorerItem<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
> = EvalScorerArgs<Input, Output, Expected, Metadata> & {
  id: string;
  trialIndex: number;
};

type DurableBatchScorerResult =
  | { id: string; score: OneOrMoreScores }
  | { id: string; error: unknown };

interface DurableBatchProcessor<Item, Result, Handle extends JsonValue> {
  batchSize?: number;
  submit(items: Item[], context: DurableBatchContext): Promise<Handle>;
  completion: DurableBatchCompletion<Handle>;
  collect(handle: Handle, context: DurableBatchContext): Promise<Result[]>;
}

interface DurableWorkflowBatchItem<Input> {
  id: string;
  input: Input;
}

type DurableWorkflowBatchResult<Output, Metadata extends BaseMetadata> =
  | {
      id: string;
      output: Output;
      metadata?: Metadata;
      tags?: string[];
    }
  | { id: string; error: unknown };

const WORKFLOW_NODE_OUTPUT: unique symbol = Symbol("DurableWorkflowNodeOutput");

interface DurableWorkflowNode<Output> {
  readonly [WORKFLOW_NODE_OUTPUT]: Output;
}

type DurableWorkflowNodeMap = Record<string, DurableWorkflowNode<unknown>>;

type DurableWorkflowNodeOutputs<Nodes extends DurableWorkflowNodeMap> = {
  [Name in keyof Nodes]: Nodes[Name] extends DurableWorkflowNode<infer Output>
    ? Output
    : never;
};

interface DurableWorkflowBuilder<RootItem, Metadata extends BaseMetadata> {
  batch<
    Output,
    Needs extends DurableWorkflowNodeMap = Record<string, never>,
    Input = RootItem,
    Handle extends JsonValue = JsonValue,
  >(
    name: string,
    processor: DurableBatchProcessor<
      DurableWorkflowBatchItem<Input>,
      DurableWorkflowBatchResult<Output, Metadata>,
      Handle
    > & {
      needs?: Needs;
      input?: (
        item: RootItem,
        outputs: DurableWorkflowNodeOutputs<Needs>,
      ) => Input;
    },
  ): DurableWorkflowNode<Output>;
}

type DurableWorkflowNodeDefinition = {
  name: string;
  needs: Record<string, string>;
  item: (
    rootItem: unknown,
    outputs: Record<string, unknown>,
    id: string,
  ) => unknown;
  processor: DurableBatchProcessor<any, any, JsonValue>;
  result: (result: any) => unknown;
};

type DurableWorkflowDefinition = {
  nodes: DurableWorkflowNodeDefinition[];
  outputNode: string;
};

interface DurableBatchTask<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
  Handle extends JsonValue,
> {
  readonly kind: typeof BATCH_TASK_KIND;
  readonly processor?: DurableBatchProcessor<
    DurableBatchTaskItem<Input, Expected, Metadata, Parameters>,
    DurableBatchTaskResult<Output, Metadata>,
    Handle
  >;
  readonly workflow?: DurableWorkflowDefinition;
}

interface DurableBatchScorer<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Handle extends JsonValue,
> {
  readonly kind: typeof BATCH_SCORER_KIND;
  name: string;
  readonly processor?: DurableBatchProcessor<
    DurableBatchScorerItem<Input, Output, Expected, Metadata>,
    DurableBatchScorerResult,
    Handle
  >;
  readonly workflow?: DurableWorkflowDefinition;
}

/**
 * Defines a task that runs through asynchronous provider batch operations.
 *
 * @experimental - The API for this function is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export function BatchTask<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
  Handle extends JsonValue = JsonValue,
>(
  processor: DurableBatchProcessor<
    DurableBatchTaskItem<Input, Expected, Metadata, Parameters>,
    DurableBatchTaskResult<Output, Metadata>,
    Handle
  >,
): DurableBatchTask<Input, Output, Expected, Metadata, Parameters, Handle>;
export function BatchTask<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
>(config: {
  workflow(
    builder: DurableWorkflowBuilder<
      DurableBatchTaskItem<Input, Expected, Metadata, Parameters>,
      Metadata
    >,
  ): DurableWorkflowNode<Output>;
}): DurableBatchTask<Input, Output, Expected, Metadata, Parameters, JsonValue>;
export function BatchTask(
  config:
    | DurableBatchProcessor<unknown, unknown, JsonValue>
    | {
        workflow(
          builder: DurableWorkflowBuilder<unknown, BaseMetadata>,
        ): DurableWorkflowNode<unknown>;
      },
): DurableBatchTask<
  unknown,
  unknown,
  unknown,
  BaseMetadata,
  EvalParameters,
  JsonValue
> {
  return {
    kind: BATCH_TASK_KIND,
    ...("workflow" in config
      ? { workflow: buildWorkflow(config.workflow) }
      : { processor: config }),
  } as DurableBatchTask<
    unknown,
    unknown,
    unknown,
    BaseMetadata,
    EvalParameters,
    JsonValue
  >;
}

/**
 * Defines a scorer that runs through asynchronous provider batch operations.
 *
 * @experimental - The API for this function is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export function BatchScorer<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Handle extends JsonValue = JsonValue,
>(
  processor: DurableBatchProcessor<
    DurableBatchScorerItem<Input, Output, Expected, Metadata>,
    DurableBatchScorerResult,
    Handle
  > & { name: string },
): DurableBatchScorer<Input, Output, Expected, Metadata, Handle>;
export function BatchScorer<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
>(config: {
  name: string;
  workflow(
    builder: DurableWorkflowBuilder<
      DurableBatchScorerItem<Input, Output, Expected, Metadata>,
      Metadata
    >,
  ): DurableWorkflowNode<OneOrMoreScores>;
}): DurableBatchScorer<Input, Output, Expected, Metadata, JsonValue>;
export function BatchScorer(
  config:
    | (DurableBatchProcessor<unknown, unknown, JsonValue> & { name: string })
    | {
        name: string;
        workflow(
          builder: DurableWorkflowBuilder<unknown, BaseMetadata>,
        ): DurableWorkflowNode<OneOrMoreScores>;
      },
): DurableBatchScorer<unknown, unknown, unknown, BaseMetadata, JsonValue> {
  return {
    kind: BATCH_SCORER_KIND,
    name: config.name,
    ...("workflow" in config
      ? { workflow: buildWorkflow(config.workflow) }
      : { processor: config }),
  } as DurableBatchScorer<unknown, unknown, unknown, BaseMetadata, JsonValue>;
}

function buildWorkflow<RootItem, Metadata extends BaseMetadata, Output>(
  define: (
    builder: DurableWorkflowBuilder<RootItem, Metadata>,
  ) => DurableWorkflowNode<Output>,
): DurableWorkflowDefinition {
  const nodes: DurableWorkflowNodeDefinition[] = [];
  const nodeNames = new Map<DurableWorkflowNode<unknown>, string>();
  const builder: DurableWorkflowBuilder<RootItem, Metadata> = {
    batch(name, config) {
      if (!name.trim()) throw new Error("Workflow batch names cannot be empty");
      if (nodes.some((node) => node.name === name)) {
        throw new Error(`Duplicate workflow batch name: ${name}`);
      }
      const needs = Object.fromEntries(
        Object.entries(config.needs ?? {}).map(([alias, dependency]) => {
          const dependencyName = nodeNames.get(dependency);
          if (!dependencyName) {
            throw new Error(
              `Workflow batch ${name} depends on an unknown or later batch`,
            );
          }
          return [alias, dependencyName];
        }),
      );
      const { input, needs: _needs, ...processor } = config;
      const handle = {} as DurableWorkflowNode<unknown>;
      nodeNames.set(handle, name);
      nodes.push({
        name,
        needs,
        item(rootItem, outputs, id) {
          return {
            id,
            input: input
              ? input(rootItem as RootItem, outputs as never)
              : rootItem,
          };
        },
        processor: processor as DurableBatchProcessor<any, any, JsonValue>,
        result: (result) => result.output,
      });
      return handle as never;
    },
  };
  const output = define(builder);
  const outputNode = nodeNames.get(output);
  if (!outputNode) {
    throw new Error("A batch workflow must return one of its batch nodes");
  }
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    const node = nodes.find((candidate) => candidate.name === name)!;
    Object.values(node.needs).forEach(visit);
  };
  visit(outputNode);
  const unused = nodes.filter((node) => !reachable.has(node.name));
  if (unused.length > 0) {
    throw new Error(
      `Batch workflow contains nodes that do not contribute to its output: ${unused
        .map((node) => node.name)
        .join(", ")}`,
    );
  }
  return { nodes, outputNode };
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

interface DurableEvalDefinition<
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
  taskNodeOutputs: Record<string, JsonValue>;
  scores: Record<string, JsonValue>;
  loggedScores: Record<string, boolean>;
  scoreNodeOutputs: Record<string, Record<string, JsonValue>>;
  classifications: Record<string, JsonValue>;
  loggedClassifications: Record<string, boolean>;
};

type DurableBatchRecord = {
  id: string;
  kind: "task" | "score";
  scorerName?: string;
  nodeName: string;
  itemIds: string[];
  handle: JsonValue;
  externalId?: string;
  status: "submitted" | "complete";
};

type DurableRunState = {
  schemaVersion: number;
  runId: string;
  projectName: string;
  evalName: string;
  experimentName: string;
  noSendLogs: boolean;
  parameters: JsonValue;
  status: "running" | "completed";
  summary?: ExperimentSummary;
  cases: DurableCaseRecord[];
  batches: DurableBatchRecord[];
};

class DurableEvalDefinitionImpl<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> implements DurableEvalDefinition<
  Input,
  Output,
  Expected,
  Metadata,
  Parameters
> {
  readonly evalName: string;

  constructor(
    readonly projectName: string,
    readonly evaluator: DurableEvaluator<
      Input,
      Output,
      Expected,
      Metadata,
      Parameters
    >,
  ) {
    this.evalName = evaluator.experimentName ?? projectName;
  }

  start(
    options: DurableEvalStartOptions<Parameters> = {},
  ): Promise<DurableEvalResult> {
    return startDurableEval(this, options);
  }

  status(options: { runId: string }): Promise<DurableEvalResult> {
    return getDurableEvalStatus(this, options);
  }

  poll(options: { runId: string }): Promise<DurableEvalResult> {
    return pollDurableEval(this, options);
  }

  processBatchResult(result: DurableBatchResult): Promise<DurableEvalResult> {
    return processDurableBatchResult(this, result);
  }
}

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
 * const redisStore = new DurableEvalRedisStore(nodeRedis);
 * ```
 *
 * ioredis:
 *
 * ```typescript
 * import Redis from "ioredis";
 * import { DurableEvalRedisStore } from "braintrust";
 *
 * const ioRedis = new Redis(process.env.REDIS_URL!);
 * const redisStore = new DurableEvalRedisStore(ioRedis);
 * ```
 *
 * Upstash:
 *
 * ```typescript
 * import { Redis } from "@upstash/redis";
 * import { DurableEvalRedisStore } from "braintrust";
 *
 * const upstashRedis = Redis.fromEnv();
 * const redisStore = new DurableEvalRedisStore(upstashRedis);
 * ```
 *
 * Other clients are compatible when `get(key)` resolves to a string, `null`, or
 * `undefined`, and `set(key, value)` accepts a string value. For local testing,
 * `new DurableEvalMemoryStore()` requires no external client, but is process-local
 * and loses its state when the process exits, so it should not be used to
 * reconnect webhooks across serverless invocations.
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
 *   task: BatchTask({
 *     // Each provider job contains at most 500 eval cases.
 *     batchSize: 500,
 *
 *     // Submit one sub-batch and return a JSON-serializable provider handle.
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
 *       externalId: (handle) => handle.id,
 *     },
 *
 *     async collect(handle) {
 *       return (await provider.results(handle.id)).map((item) => ({
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
 *   async poll(handle) {
 *     const batch = await provider.getBatch(handle.id);
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
 * collecting results, or advancing the workflow:
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
 * ### Multi-stage workflows
 *
 * The direct `BatchTask({ submit, completion, collect })` form remains the
 * one-batch shorthand. Use `workflow` when a task or scorer requires multiple
 * provider batch operations:
 *
 * ```typescript
 * task: BatchTask({
 *   workflow(workflow) {
 *     const draft = workflow.batch("draft", {
 *       input: ({ input }) => ({ prompt: input }),
 *       batchSize: 500,
 *       submit: submitDraftBatch,
 *       completion: draftCompletion,
 *       collect: collectDraftBatch,
 *     });
 *
 *     return workflow.batch("revise", {
 *       needs: { draft },
 *       input: ({ input }, { draft }) => ({ original: input, draft }),
 *       batchSize: 500,
 *       submit: submitRevisionBatch,
 *       completion: revisionCompletion,
 *       collect: collectRevisionBatch,
 *     });
 *   },
 * }),
 * ```
 *
 * Every named batch is a persisted workflow node. `needs` can express sequential
 * operations, parallel branches, and joins. The returned node supplies the final
 * task output or scorer result.
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
 *     // The provider's batch ID. The durable eval saved it from submit()'s handle.
 *     externalId: batch.id,
 *     // The SDK-generated ID passed to submit(); include it in provider metadata
 *     // when the webhook cannot provide the external ID used by the handle.
 *     batchId: batch.metadata?.durableBatchId,
 *   });
 *
 *   response.status(result.status === "waiting" ? 202 : 200).end();
 * });
 * ```
 *
 * The method accepts either `externalId` or `batchId`. The stored batch locator
 * identifies the task or scorer workflow node, whose `collect()` results are
 * stored before the eval advances. Webhook idempotency and provider failure
 * handling remain application responsibilities for now.
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
): DurableEvalDefinition<Input, Output, Expected, Metadata, Parameters> {
  return new DurableEvalDefinitionImpl(projectName, evaluator);
}

async function startDurableEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalDefinition<
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
      schemaVersion: CHECKPOINT_VERSION,
      runId,
      projectName: definition.projectName,
      evalName: definition.evalName,
      experimentName,
      noSendLogs: options.noSendLogs ?? false,
      parameters: assertJsonValue(parameters, "eval parameters"),
      status: "completed",
      summary: result.summary,
      cases: [],
      batches: [],
    };
    await experiment?.flush();
    await writeJson(store, key, state);
    return currentStatus(definition, state);
  }
  const state: DurableRunState = {
    schemaVersion: CHECKPOINT_VERSION,
    runId,
    projectName: definition.projectName,
    evalName: definition.evalName,
    experimentName,
    noSendLogs: options.noSendLogs ?? false,
    parameters: assertJsonValue(parameters, "eval parameters"),
    status: "running",
    cases: await materializeCases(definition, data, experiment),
    batches: [],
  };
  await writeJson(store, key, state);
  return advanceDurableEval(definition, state, store, key, experiment);
}

async function getDurableEvalStatus<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalDefinition<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >,
  options: { runId: string },
): Promise<DurableEvalResult> {
  const store = definition.evaluator.store;
  const state = await readJson<DurableRunState>(
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
  definition: DurableEvalDefinition<
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
  const state = await readJson<DurableRunState>(store, key);
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
    await collectBatch(definition, state, batch);
    batch.status = "complete";
    await writeJson(store, key, state);
  }
  return advanceDurableEval(definition, state, store, key);
}

async function pollDurableEval<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalDefinition<
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
  const state = await readJson<DurableRunState>(store, key);
  if (!state) throw new Error(`Durable eval run ${options.runId} is missing`);

  const batches = state.batches.filter((batch) => {
    if (batch.status === "complete") return false;
    return processorForBatch(definition, batch).completion.mode === "poll";
  });
  const results = await Promise.all(
    batches.map(async (batch) => ({
      batch,
      result: await (
        processorForBatch(definition, batch).completion as Extract<
          DurableBatchCompletion<JsonValue>,
          { mode: "poll" }
        >
      ).poll(batch.handle, {
        runId: state.runId,
        batchId: batch.id,
      }),
    })),
  );
  for (const { batch, result } of results) {
    if (result.status === "failed") throw asError(result.error);
    if (result.status !== "complete") continue;
    await collectBatch(definition, state, batch);
    batch.status = "complete";
    await writeJson(store, key, state);
  }
  return advanceDurableEval(definition, state, store, key);
}

async function openDurableExperiment(
  definition: DurableEvalDefinition<any, any, any, any, any>,
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
  definition: DurableEvalDefinition<
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
  if (state.cases.some((record) => !record.taskComplete)) {
    return currentStatus(definition, state);
  }

  await runScoreStages(definition, state, store, key, experiment);
  const scorerNames = resolveScorers(definition.evaluator.scores ?? []).map(
    ({ name }) => name,
  );
  if (
    state.cases.some((record) =>
      scorerNames.some((name) => !(name in record.scores)),
    )
  ) {
    return currentStatus(definition, state);
  }

  state.summary = await finishExperiment(definition, state, experiment);
  state.status = "completed";
  await writeJson(store, key, state);
  return currentStatus(definition, state);
}

function currentStatus(
  definition: DurableEvalDefinition<any, any, any, any, any>,
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
    pending[processorForBatch(definition, batch).completion.mode]++;
  }
  return { status: "waiting", runId: state.runId, pending };
}

async function startCaseRoot(
  definition: DurableEvalDefinition<any, any, any, any, any>,
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
  definition: DurableEvalDefinition<any, any, any, any, any>,
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
    await experiment?.flush();
  }
}

async function logCompletedTasks(
  definition: DurableEvalDefinition<any, any, any, any, any>,
  state: DurableRunState,
  store: DurableEvalStore,
  key: string,
  experiment: Experiment | null,
) {
  for (const record of state.cases) {
    if (!record.taskComplete || record.taskLogged) continue;
    await logTaskResult(definition, state, record, experiment);
    await writeJson(store, key, state);
  }
}

async function runTaskStage<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalDefinition<
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
    await ensureWorkflowBatches(definition, state, store, key, "task");
    return;
  }

  const task = definition.evaluator.task as EvalTask<
    Input,
    Output,
    Expected,
    Metadata,
    Parameters
  >;
  for (const record of state.cases) {
    if (record.taskComplete) continue;
    await logTaskResult(definition, state, record, experiment, task);
    await writeJson(store, key, state);
  }
}

async function runScoreStages<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalDefinition<
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
  for (const { name, scorer } of scorers) {
    if (isBatchScorer(scorer)) {
      for (const record of state.cases) {
        if (name in record.scores && !record.loggedScores[name]) {
          await evaluateAndLogScore(
            definition,
            state,
            record,
            name,
            experiment,
          );
          await writeJson(store, key, state);
        }
      }
      await ensureWorkflowBatches(definition, state, store, key, "score", name);
      continue;
    }
    for (const record of state.cases) {
      if (record.loggedScores[name]) continue;
      await evaluateAndLogScore(
        definition,
        state,
        record,
        name,
        experiment,
        scorer,
      );
      await writeJson(store, key, state);
    }
  }

  for (const [index, classifier] of (
    definition.evaluator.classifiers ?? []
  ).entries()) {
    const name = classifierName(classifier, index);
    for (const record of state.cases) {
      if (record.loggedClassifications[name]) continue;
      await evaluateAndLogClassification(
        definition,
        state,
        record,
        name,
        classifier,
        experiment,
      );
      await writeJson(store, key, state);
    }
  }
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
  definition: DurableEvalDefinition<any, any, any, any, any>,
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
  definition: DurableEvalDefinition<any, any, any, any, any>,
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
    await experiment?.flush();
  }
}

async function evaluateAndLogClassification(
  definition: DurableEvalDefinition<any, any, any, any, any>,
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
    await experiment?.flush();
  }
}

async function ensureWorkflowBatches(
  definition: DurableEvalDefinition<any, any, any, any, any>,
  state: DurableRunState,
  store: DurableEvalStore,
  key: string,
  kind: "task" | "score",
  scorerName?: string,
) {
  const workflow = workflowForStage(definition, kind, scorerName);
  for (const node of workflow.nodes) {
    const batchSize = node.processor.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        `Invalid batchSize for ${scorerName ? `${scorerName}.${node.name}` : node.name}`,
      );
    }
    const assigned = new Set(
      state.batches
        .filter(
          (batch) =>
            batch.kind === kind &&
            batch.scorerName === scorerName &&
            batch.nodeName === node.name,
        )
        .flatMap((batch) => batch.itemIds),
    );
    const eligible = state.cases.filter((record) => {
      const outputs = nodeOutputsFor(record, kind, scorerName);
      return (
        !assigned.has(record.id) &&
        !(node.name in outputs) &&
        Object.values(node.needs).every((dependency) => dependency in outputs)
      );
    });
    for (let offset = 0; offset < eligible.length; offset += batchSize) {
      const records = eligible.slice(offset, offset + batchSize);
      const batchId = newId();
      const context = { runId: state.runId, batchId };
      const items = records.map((record) =>
        itemForNode(state.parameters, record, kind, scorerName, node),
      );
      const handle = assertJsonValue(
        await node.processor.submit(items, context),
        `handle for batch ${batchId}`,
      );
      const externalId =
        node.processor.completion.mode === "webhook"
          ? node.processor.completion.externalId(handle, context)
          : undefined;
      if (externalId !== undefined && !externalId.trim()) {
        throw new Error(`Batch ${batchId} produced an empty externalId`);
      }
      const batch: DurableBatchRecord = {
        id: batchId,
        kind,
        scorerName,
        nodeName: node.name,
        itemIds: records.map((record) => record.id),
        handle,
        externalId,
        status: "submitted",
      };
      state.batches.push(batch);
      await writeJson(store, key, state);
    }
  }
}

async function collectBatch(
  definition: DurableEvalDefinition<any, any, any, any, any>,
  state: DurableRunState,
  batch: DurableBatchRecord,
) {
  const workflow = workflowForStage(definition, batch.kind, batch.scorerName);
  const node = workflow.nodes.find(
    (candidate) => candidate.name === batch.nodeName,
  );
  if (!node)
    throw new Error(
      `Definition no longer contains batch node ${batch.nodeName}`,
    );
  const processor = node.processor;
  const context = { runId: state.runId, batchId: batch.id };
  const results = await processor.collect(batch.handle, context);
  if (!Array.isArray(results)) {
    throw new Error(`collect for batch ${batch.id} must return an array`);
  }
  const expectedIds = new Set(batch.itemIds);
  const seen = new Set<string>();
  for (const result of results) {
    const id = resultItemId(result);
    if (!expectedIds.has(id)) {
      throw new Error(`Batch ${batch.id} returned unknown item ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Batch ${batch.id} returned item ${id} more than once`);
    }
    seen.add(id);
    if ("error" in result) throw asError(result.error);
    const record = state.cases.find((candidate) => candidate.id === id)!;
    const output = assertJsonValue(
      node.result(result),
      `output for ${batch.nodeName} item ${id}`,
    );
    nodeOutputsFor(record, batch.kind, batch.scorerName)[batch.nodeName] =
      output;
    if (batch.nodeName !== workflow.outputNode) continue;
    if (batch.kind === "task") {
      record.output = output;
      if ("metadata" in result && result.metadata !== undefined) {
        record.metadata = assertJsonValue(
          result.metadata,
          `metadata for ${id}`,
        );
      }
      if ("tags" in result && result.tags !== undefined)
        record.tags = result.tags;
      record.taskComplete = true;
    } else {
      record.scores[batch.scorerName!] = assertJsonValue(
        output,
        `score for ${id}`,
      );
    }
  }
  const missing = batch.itemIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Batch ${batch.id} did not return results for: ${missing.join(", ")}`,
    );
  }
}

function processorForBatch(
  definition: DurableEvalDefinition<any, any, any, any, any>,
  batch: DurableBatchRecord,
): DurableBatchProcessor<any, any, JsonValue> {
  const node = workflowForStage(
    definition,
    batch.kind,
    batch.scorerName,
  ).nodes.find((candidate) => candidate.name === batch.nodeName);
  if (!node)
    throw new Error(
      `Definition no longer contains batch node ${batch.nodeName}`,
    );
  return node.processor;
}

function workflowForStage(
  definition: DurableEvalDefinition<any, any, any, any, any>,
  kind: "task" | "score",
  scorerName?: string,
): DurableWorkflowDefinition {
  let stage:
    | DurableBatchTask<any, any, any, any, any, JsonValue>
    | DurableBatchScorer<any, any, any, any, JsonValue>;
  if (kind === "task") {
    if (!isBatchTask(definition.evaluator.task)) {
      throw new Error("Definition no longer contains the batch task");
    }
    stage = definition.evaluator.task;
  } else {
    const scorer = resolveScorers(definition.evaluator.scores ?? []).find(
      ({ name }) => name === scorerName,
    )?.scorer;
    if (!isBatchScorer(scorer)) {
      throw new Error(`Definition no longer contains scorer ${scorerName}`);
    }
    stage = scorer;
  }
  if (stage.workflow) return stage.workflow;
  if (!stage.processor) {
    throw new Error("Batch definition has neither a processor nor a workflow");
  }
  return {
    outputNode: "$batch",
    nodes: [
      {
        name: "$batch",
        needs: {},
        item: (rootItem) => rootItem,
        processor: stage.processor as DurableBatchProcessor<
          any,
          any,
          JsonValue
        >,
        result:
          kind === "task"
            ? (result) => result.output
            : (result) => result.score,
      },
    ],
  };
}

function itemForNode(
  parameters: JsonValue,
  record: DurableCaseRecord,
  kind: "task" | "score",
  scorerName: string | undefined,
  node: DurableWorkflowNodeDefinition,
) {
  const rootItem =
    kind === "task"
      ? taskBatchItem(record, parameters)
      : scorerBatchItem(record);
  const outputs = nodeOutputsFor(record, kind, scorerName);
  return node.item(
    rootItem,
    Object.fromEntries(
      Object.entries(node.needs).map(([alias, dependency]) => [
        alias,
        outputs[dependency],
      ]),
    ),
    record.id,
  );
}

function nodeOutputsFor(
  record: DurableCaseRecord,
  kind: "task" | "score",
  scorerName?: string,
) {
  if (kind === "task") return record.taskNodeOutputs;
  return (record.scoreNodeOutputs[scorerName!] ??= {});
}

async function materializeCases<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  definition: DurableEvalDefinition<
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
        taskNodeOutputs: {},
        scores: {},
        loggedScores: {},
        scoreNodeOutputs: {},
        classifications: {},
        loggedClassifications: {},
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
  definition: DurableEvalDefinition<any, any, any, any, any>,
  state: DurableRunState,
  experiment: Experiment | null,
) {
  const scorerNames = resolveScorers(definition.evaluator.scores ?? []).map(
    ({ name }) => name,
  );
  const results = state.cases.map((record) => {
    const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
    const scores = Object.assign(
      {},
      ...scorerNames.map(
        (name) =>
          _internalPrepareEvaluatorScore(
            record.scores[name] as OneOrMoreScores,
            name,
          ).scores ?? {},
      ),
    );
    const classifications = Object.assign(
      {},
      ...Object.entries(record.classifications).map(
        ([name, value]) =>
          _internalPrepareEvaluatorClassification(value as never, name)
            .classifications ?? {},
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
  return `durable-eval/v2/runs/${contentVersion(encoder.encode(`${projectName}\0${evalName}\0${runId}`))}`;
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
