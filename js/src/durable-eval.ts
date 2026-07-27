import { type Score, SpanTypeAttribute } from "../util/index";
import iso from "./isomorph";
import {
  type BaseMetadata,
  type BraintrustState,
  type DefaultMetadataType,
  type EvalCase,
  type Experiment,
  type ExperimentSummary,
  NOOP_SPAN,
  _internalStartSpanWithInitialMerge,
  init as initExperiment,
  newId,
} from "./logger";
import {
  type EvalData,
  type EvalHooks,
  type EvalScorer,
  type EvalScorerArgs,
  type EvalTask,
  type OneOrMoreScores,
} from "./framework";
import { type EvalParameters, type InferParameters } from "./eval-parameters";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BATCH_TASK_KIND = "braintrust.durable.batch-task";
const BATCH_SCORER_KIND = "braintrust.durable.batch-scorer";
const CHECKPOINT_VERSION = 2;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_CONCURRENT_BATCHES = 1;
const JOB_LEASE_MS = 60_000;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DurableEvalWriteCondition =
  | { ifAbsent: true }
  | { ifVersion: string }
  | { unconditional: true };

export interface DurableEvalStore {
  read(
    key: string,
  ): Promise<{ value: Uint8Array; version: string } | undefined>;
  write(
    key: string,
    value: Uint8Array,
    condition: DurableEvalWriteCondition,
  ): Promise<
    | { written: true; version: string }
    | { written: false; currentVersion?: string }
  >;
  list(prefix: string): AsyncIterable<string>;
}

/**
 * Throw this from `submit` only when it is known that no provider job was
 * created. Other submit errors are treated as ambiguous and pause the run.
 */
export class DurableEvalNotSubmittedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableEvalNotSubmittedError";
  }
}

export class MemoryDurableEvalStore implements DurableEvalStore {
  private readonly values = new Map<
    string,
    { value: Uint8Array; version: number }
  >();

  async read(key: string) {
    const record = this.values.get(key);
    return record
      ? { value: record.value.slice(), version: String(record.version) }
      : undefined;
  }

  async write(
    key: string,
    value: Uint8Array,
    condition: DurableEvalWriteCondition,
  ) {
    const current = this.values.get(key);
    if (
      ("ifAbsent" in condition && current) ||
      ("ifVersion" in condition &&
        (!current || String(current.version) !== condition.ifVersion))
    ) {
      return {
        written: false as const,
        currentVersion: current ? String(current.version) : undefined,
      };
    }
    const version = (current?.version ?? 0) + 1;
    this.values.set(key, { value: value.slice(), version });
    return { written: true as const, version: String(version) };
  }

  async *list(prefix: string) {
    for (const key of [...this.values.keys()].sort()) {
      if (key.startsWith(prefix)) {
        yield key;
      }
    }
  }
}

/**
 * A filesystem checkpoint store intended for durable, multi-process evals on
 * one machine. Distributed deployments should provide a database/object-store
 * implementation of {@link DurableEvalStore}.
 */
export class FileDurableEvalStore implements DurableEvalStore {
  constructor(public readonly root = ".braintrust/evals") {}

  private assertFilesystem() {
    if (
      !iso.pathJoin ||
      !iso.pathDirname ||
      !iso.mkdir ||
      !iso.readFile ||
      !iso.writeFile ||
      !iso.readdir ||
      !iso.stat ||
      !iso.unlink ||
      !iso.rename ||
      !iso.openFile
    ) {
      throw new Error(
        "FileDurableEvalStore is only available in a Node.js filesystem environment",
      );
    }
  }

  private pathFor(key: string) {
    if (
      key.startsWith("/") ||
      key.split("/").some((part) => part === ".." || part === ".")
    ) {
      throw new Error(`Invalid durable eval store key: ${key}`);
    }
    return iso.pathJoin!(this.root, ...key.split("/"));
  }

  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${path}.lock`;
    await iso.mkdir!(iso.pathDirname!(path), { recursive: true });
    const started = Date.now();
    let handle: { close(): Promise<void> } | undefined;
    while (!handle) {
      try {
        handle = await iso.openFile!(lockPath, "wx");
      } catch (error) {
        if (!isErrorCode(error, "EEXIST") || Date.now() - started >= 10_000) {
          throw error;
        }
        await delay(10);
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await iso.unlink!(lockPath).catch(() => undefined);
    }
  }

  async read(key: string) {
    this.assertFilesystem();
    const path = this.pathFor(key);
    try {
      const value = await iso.readFile!(path);
      return { value, version: contentVersion(value) };
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async write(
    key: string,
    value: Uint8Array,
    condition: DurableEvalWriteCondition,
  ) {
    this.assertFilesystem();
    const path = this.pathFor(key);
    return await this.withLock(path, async () => {
      const current = await this.read(key);
      if (
        ("ifAbsent" in condition && current) ||
        ("ifVersion" in condition && current?.version !== condition.ifVersion)
      ) {
        return {
          written: false as const,
          currentVersion: current?.version,
        };
      }

      await iso.mkdir!(iso.pathDirname!(path), { recursive: true });
      const tempPath = `${path}.${newId()}.tmp`;
      await iso.writeFile!(tempPath, value);
      await iso.rename!(tempPath, path);
      return { written: true as const, version: contentVersion(value) };
    });
  }

  async *list(prefix: string) {
    this.assertFilesystem();
    const prefixPath = this.pathFor(prefix);
    const walk = async function* (path: string): AsyncGenerator<string> {
      let entries: string[];
      try {
        entries = await iso.readdir!(path);
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) return;
        throw error;
      }
      for (const entry of entries.sort()) {
        if (
          entry.endsWith(".lock") ||
          entry.endsWith(".tmp") ||
          entry.includes(".tmp.")
        ) {
          continue;
        }
        const child = iso.pathJoin!(path, entry);
        const stat = await iso.stat!(child);
        if (stat.isDirectory()) {
          yield* walk(child);
        } else {
          yield child;
        }
      }
    };

    for await (const path of walk(prefixPath)) {
      yield path
        .slice(this.root.length)
        .replace(/^[/\\]+/, "")
        .replaceAll("\\", "/");
    }
  }
}

export interface DurableBatchContext {
  runId: string;
  stage: string;
  revision: string;
  shard: { index: number; count: number };
  attempt: number;
  batchId: string;
  itemCount: number;
  signal: AbortSignal;
}

export type DurableBatchPoll =
  | { status: "pending"; retryAfterMs?: number }
  | { status: "complete" }
  | { status: "failed"; error: unknown; retryable?: boolean };

export type DurableBatchRecovery<Handle> =
  | { status: "found"; handle: Handle }
  | { status: "not_found" }
  | { status: "unknown" };

export type DurableBatchOutcome =
  | { status: "complete" }
  | { status: "failed"; error: JsonValue; retryable?: boolean };

export type DurableBatchCompletion<Handle extends JsonValue> =
  | {
      mode: "poll";
      poll(
        handle: Handle,
        context: DurableBatchContext,
      ): Promise<DurableBatchPoll>;
      intervalMs?: number;
    }
  | {
      mode: "webhook";
      source: string;
      externalId(handle: Handle, context: DurableBatchContext): string;
      pollFallback?: {
        afterMs: number;
        intervalMs?: number;
        poll(
          handle: Handle,
          context: DurableBatchContext,
        ): Promise<DurableBatchPoll>;
      };
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

export type DurableBatchTaskResult<Output, Metadata extends BaseMetadata> =
  | {
      id: string;
      output: Output;
      metadata?: Metadata;
      tags?: string[];
    }
  | { id: string; error: unknown; retryable?: boolean };

export type DurableBatchScorerItem<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
> = EvalScorerArgs<Input, Output, Expected, Metadata> & {
  id: string;
  trialIndex: number;
};

export type DurableBatchScorerResult =
  | { id: string; score: OneOrMoreScores }
  | { id: string; error: unknown; retryable?: boolean };

export interface DurableBatchProcessor<Item, Result, Handle extends JsonValue> {
  revision: string;
  batchSize?: number;
  maxConcurrentBatches?: number;
  maxAttempts?: number;
  submit(items: Item[], context: DurableBatchContext): Promise<Handle>;
  recover?(context: DurableBatchContext): Promise<DurableBatchRecovery<Handle>>;
  completion: DurableBatchCompletion<Handle>;
  collect(
    handle: Handle,
    context: DurableBatchContext,
  ): AsyncIterable<Result> | Promise<Iterable<Result> | AsyncIterable<Result>>;
  cancel?(handle: Handle, context: DurableBatchContext): Promise<void>;
}

export interface DurableBatchTask<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
  Handle extends JsonValue,
> extends DurableBatchProcessor<
  DurableBatchTaskItem<Input, Expected, Metadata, Parameters>,
  DurableBatchTaskResult<Output, Metadata>,
  Handle
> {
  readonly kind: typeof BATCH_TASK_KIND;
}

export interface DurableBatchScorer<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Handle extends JsonValue,
> extends DurableBatchProcessor<
  DurableBatchScorerItem<Input, Output, Expected, Metadata>,
  DurableBatchScorerResult,
  Handle
> {
  readonly kind: typeof BATCH_SCORER_KIND;
  name: string;
}

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
): DurableBatchTask<Input, Output, Expected, Metadata, Parameters, Handle> {
  return { kind: BATCH_TASK_KIND, ...processor };
}

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
): DurableBatchScorer<Input, Output, Expected, Metadata, Handle> {
  return { kind: BATCH_SCORER_KIND, ...processor };
}

export type DurableEvaluator<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> = {
  revision: string;
  data: EvalData<Input, Expected, Metadata>;
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
  scores: Array<
    | EvalScorer<Input, Output, Expected, Metadata>
    | DurableBatchScorer<Input, Output, Expected, Metadata, JsonValue>
  >;
  parameters?: InferParameters<Parameters>;
  experimentName?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  trialCount?: number;
  projectId?: string;
  state?: BraintrustState;
};

export interface DurableEvalRuntimeOptions {
  runId?: string;
  store?: DurableEvalStore;
  shard?: { index: number; count: number };
  deadlineMs?: number;
  signal?: AbortSignal;
  noSendLogs?: boolean;
  workerId?: string;
  checkpointDir?: string;
}

export interface DurableEvalExistingRunOptions extends DurableEvalRuntimeOptions {
  runId: string;
}

export type DurableEvalOperation =
  | "run"
  | "status"
  | "retry-failed"
  | "resubmit-unknown"
  | "cancel";

type DurableEvalExecutionOptions = DurableEvalRuntimeOptions & {
  operation?: DurableEvalOperation;
};

export type DurableBatchResultEvent = {
  eventId: string;
  source: string;
  externalId?: string;
  batchId?: string;
  handle?: JsonValue;
  outcome: DurableBatchOutcome;
  payload?: JsonValue;
};

export type DurableBatchProcessingResult =
  | {
      status: "processed";
      batchId: string;
      run: DurableEvalResult;
    }
  | { status: "duplicate"; batchId?: string }
  | {
      status: "pending";
      reason: "unmatched" | "definition_missing";
      batchId?: string;
    };

export interface DurableEvalDefinition<
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
  run(options?: DurableEvalRuntimeOptions): Promise<DurableEvalResult>;
  status(options: DurableEvalExistingRunOptions): Promise<DurableEvalResult>;
  retryFailed(
    options: DurableEvalExistingRunOptions,
  ): Promise<DurableEvalResult>;
  resubmitUnknown(
    options: DurableEvalExistingRunOptions,
  ): Promise<DurableEvalResult>;
  cancel(options: DurableEvalExistingRunOptions): Promise<DurableEvalResult>;
  processBatchResult(
    event: DurableBatchResultEvent,
    options?: Omit<DurableEvalRuntimeOptions, "runId" | "shard">,
  ): Promise<DurableBatchProcessingResult>;
}

export interface DurableEvalProgress {
  total: number;
  taskPending: number;
  taskSucceeded: number;
  taskFailed: number;
  scorePending: number;
  scoreSucceeded: number;
  scoreFailed: number;
  unknown: number;
}

export interface DurableEvalFailureSummary {
  tasks: number;
  scorers: number;
}

export type DurableEvalPauseReason =
  | "deadline"
  | "aborted"
  | "shard_complete"
  | "waiting_for_webhook"
  | "unknown_submission"
  | "provider_unreachable"
  | "status_only";

export type DurableEvalResult =
  | {
      status: "completed";
      runId: string;
      summary: ExperimentSummary;
      progress: DurableEvalProgress;
      failures: DurableEvalFailureSummary;
    }
  | {
      status: "paused";
      runId: string;
      reason: DurableEvalPauseReason;
      progress: DurableEvalProgress;
      resume(
        overrides?: Partial<DurableEvalRuntimeOptions>,
      ): Promise<DurableEvalResult>;
    };

type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
};

type StageState =
  | { status: "pending"; attempts: number }
  | {
      status: "leased";
      attempts: number;
      workerId: string;
      leaseUntil: number;
    }
  | {
      status: "in_batch";
      attempts: number;
      batchId: string;
      revision: string;
    }
  | {
      status: "succeeded";
      attempts: number;
      revision: string;
      value: JsonValue;
    }
  | {
      status: "failed";
      attempts: number;
      revision: string;
      error: SerializedError;
    }
  | {
      status: "unknown";
      attempts: number;
      revision: string;
      batchId: string;
    };

type DurableCaseRecord = {
  id: string;
  caseId: string;
  trialIndex: number;
  shard: number;
  datum: JsonValue;
  task: StageState;
  scores: Record<string, StageState>;
  metadata: JsonValue;
  tags?: string[];
  logPending?: boolean;
};

type DurableJobRecord = {
  id: string;
  stage: string;
  kind: "task" | "score";
  scorerName?: string;
  itemIds: string[];
  attempt: number;
  revision: string;
  shard: number;
  status:
    | "preparing"
    | "submitting"
    | "submitted"
    | "complete"
    | "failed"
    | "unknown";
  workerId?: string;
  leaseUntil?: number;
  handle?: JsonValue;
  external?: { source: string; id: string };
  submittedAt?: number;
  outcome?: DurableBatchOutcome;
  webhookEventKey?: string;
  nextPollAt?: number;
  error?: SerializedError;
};

type DurableRunManifest = {
  schemaVersion: number;
  runId: string;
  projectName: string;
  evalName: string;
  revision: string;
  shardCount: number;
  dataSealed: boolean;
  activeScorers: string[];
  experimentName?: string;
  createdAt: string;
};

type Versioned<T> = { value: T; version: string };

type DurableBatchLocator = {
  schemaVersion: number;
  projectName: string;
  evalName: string;
  runId: string;
  prefix: string;
  jobKey: string;
  batchId: string;
  stage: string;
  kind: "task" | "score";
  scorerName?: string;
  shard: number;
  shardCount: number;
};

type DurableWebhookEventRecord = {
  schemaVersion: number;
  event: DurableBatchResultEvent;
  receivedAt: string;
  status: "pending" | "applied";
  batchId?: string;
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

  run(options: DurableEvalRuntimeOptions = {}) {
    return runDurableEval(this.projectName, this.evaluator, options);
  }

  status(options: DurableEvalExistingRunOptions) {
    return runDurableEval(this.projectName, this.evaluator, {
      ...options,
      operation: "status",
    });
  }

  retryFailed(options: DurableEvalExistingRunOptions) {
    return runDurableEval(this.projectName, this.evaluator, {
      ...options,
      operation: "retry-failed",
    });
  }

  resubmitUnknown(options: DurableEvalExistingRunOptions) {
    return runDurableEval(this.projectName, this.evaluator, {
      ...options,
      operation: "resubmit-unknown",
    });
  }

  cancel(options: DurableEvalExistingRunOptions) {
    return runDurableEval(this.projectName, this.evaluator, {
      ...options,
      operation: "cancel",
    });
  }

  processBatchResult(
    event: DurableBatchResultEvent,
    options: Omit<DurableEvalRuntimeOptions, "runId" | "shard"> = {},
  ): Promise<DurableBatchProcessingResult> {
    return processDurableBatchResult(this, event, options);
  }
}

export function DurableEval<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
>(
  projectName: string,
  evaluator: DurableEvaluator<Input, Output, Expected, Metadata, Parameters>,
): DurableEvalDefinition<Input, Output, Expected, Metadata, Parameters> {
  const definition = new DurableEvalDefinitionImpl(projectName, evaluator);
  if (globalThis._lazy_load) {
    globalThis._evals.durableEvaluators ??= {};
    globalThis._evals.durableEvaluators[definition.evalName] = {
      definition,
    };
  }
  return definition;
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
  event: DurableBatchResultEvent,
  options: Omit<DurableEvalRuntimeOptions, "runId" | "shard">,
): Promise<DurableBatchProcessingResult> {
  if (!event.eventId.trim() || !event.source.trim()) {
    throw new Error(
      "Durable batch webhook events require non-empty eventId and source",
    );
  }
  if (!event.batchId && !event.externalId) {
    throw new Error(
      "Durable batch webhook events require batchId or externalId",
    );
  }
  if (event.externalId !== undefined && !event.externalId.trim()) {
    throw new Error("Durable batch webhook externalId must be non-empty");
  }
  const normalizedEvent = assertJsonValue(
    event,
    "durable batch webhook event",
  ) as DurableBatchResultEvent;
  const store =
    options.store ??
    new FileDurableEvalStore(options.checkpointDir ?? ".braintrust/evals");
  const storedEventKey = webhookEventKey(event.source, event.eventId);
  const eventRecord: DurableWebhookEventRecord = {
    schemaVersion: CHECKPOINT_VERSION,
    event: normalizedEvent,
    receivedAt: new Date().toISOString(),
    status: "pending",
    batchId: event.batchId,
  };
  const inserted = await writeJson(store, storedEventKey, eventRecord, {
    ifAbsent: true,
  });
  if (!inserted.written) {
    const existing = await readJson<DurableWebhookEventRecord>(
      store,
      storedEventKey,
    );
    if (
      !existing ||
      stableStringify(existing.value.event) !== stableStringify(normalizedEvent)
    ) {
      throw new Error(
        `Webhook event ${event.source}/${event.eventId} was reused with different contents`,
      );
    }
    if (existing.value.status === "applied") {
      return {
        status: "duplicate",
        batchId: existing.value.batchId ?? event.batchId,
      };
    }
  }

  if (event.externalId) {
    await writeJson(
      store,
      webhookMailboxKey(event.source, event.externalId, storedEventKey),
      { eventKey: storedEventKey },
      { ifAbsent: true },
    );
  }

  const internalLocator = event.batchId
    ? await readJson<DurableBatchLocator>(
        store,
        internalBatchIndexKey(event.batchId),
      )
    : undefined;
  const externalLocator = event.externalId
    ? await readJson<DurableBatchLocator>(
        store,
        externalBatchIndexKey(event.source, event.externalId),
      )
    : undefined;
  if (
    internalLocator &&
    externalLocator &&
    internalLocator.value.jobKey !== externalLocator.value.jobKey
  ) {
    throw new Error(
      "Durable batch webhook batchId and externalId resolve to different jobs",
    );
  }
  const locator = internalLocator?.value ?? externalLocator?.value;
  if (!locator) {
    return { status: "pending", reason: "unmatched", batchId: event.batchId };
  }
  if (
    locator.projectName !== definition.projectName ||
    locator.evalName !== definition.evalName
  ) {
    return {
      status: "pending",
      reason: "definition_missing",
      batchId: locator.batchId,
    };
  }

  const processor = batchProcessorForLocator(definition.evaluator, locator);
  if (
    !processor ||
    processor.completion.mode !== "webhook" ||
    processor.completion.source !== event.source
  ) {
    return {
      status: "pending",
      reason: "definition_missing",
      batchId: locator.batchId,
    };
  }

  const attached = await attachWebhookEventToJob(
    store,
    locator.jobKey,
    storedEventKey,
    normalizedEvent,
  );
  if (attached === "missing") {
    return {
      status: "pending",
      reason: "unmatched",
      batchId: locator.batchId,
    };
  }
  if (attached === "duplicate") {
    await markWebhookEventApplied(store, storedEventKey, locator.batchId);
    return { status: "duplicate", batchId: locator.batchId };
  }

  const run = await runDurableEval(
    definition.projectName,
    definition.evaluator,
    {
      ...options,
      runId: locator.runId,
      shard: { index: locator.shard, count: locator.shardCount },
    },
  );
  const job = await readJson<DurableJobRecord>(store, locator.jobKey);
  if (
    job &&
    (job.value.status === "complete" || job.value.status === "failed")
  ) {
    await markWebhookEventApplied(store, storedEventKey, locator.batchId);
  }
  return { status: "processed", batchId: locator.batchId, run };
}

async function runDurableEval<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
>(
  projectName: string,
  evaluator: DurableEvaluator<Input, Output, Expected, Metadata, Parameters>,
  options: DurableEvalExecutionOptions = {},
): Promise<DurableEvalResult> {
  const runId = options.runId ?? newId();
  const shard = options.shard ?? { index: 0, count: 1 };
  validateShard(shard);
  const workerId = options.workerId ?? newId();
  const store =
    options.store ??
    new FileDurableEvalStore(options.checkpointDir ?? ".braintrust/evals");
  const evalName = evaluator.experimentName ?? projectName;
  const prefix = runPrefix(projectName, evalName, runId);
  const manifestKey = `${prefix}/manifest`;
  const scorerDefinitions = resolveScorers(evaluator.scores);
  const scorerNames = scorerDefinitions.map((definition) => definition.name);
  const webhookStages = new Set<string>();
  if (
    isBatchTask(evaluator.task) &&
    evaluator.task.completion.mode === "webhook" &&
    evaluator.task.completion.pollFallback === undefined
  ) {
    webhookStages.add("task");
  }
  for (const definition of scorerDefinitions) {
    if (
      isBatchScorer(definition.scorer) &&
      definition.scorer.completion.mode === "webhook" &&
      definition.scorer.completion.pollFallback === undefined
    ) {
      webhookStages.add(`score:${definition.name}`);
    }
  }
  if (new Set(scorerNames).size !== scorerNames.length) {
    throw new Error("DurableEval scorer names must be unique");
  }

  const existingManifest = await readJson<DurableRunManifest>(
    store,
    manifestKey,
  );
  if (options.operation && options.operation !== "run" && !existingManifest) {
    throw new Error(`DurableEval run ${runId} does not exist`);
  }
  let manifest =
    existingManifest ??
    (await initializeManifest(store, manifestKey, {
      schemaVersion: CHECKPOINT_VERSION,
      runId,
      projectName,
      evalName,
      revision: evaluator.revision,
      shardCount: shard.count,
      dataSealed: false,
      activeScorers: scorerNames,
      experimentName: evaluator.experimentName,
      createdAt: new Date().toISOString(),
    }));
  if (manifest.value.shardCount !== shard.count) {
    throw new Error(
      `DurableEval run ${runId} was created with ${manifest.value.shardCount} shards, not ${shard.count}`,
    );
  }

  if (!manifest.value.dataSealed) {
    await materializeData({
      store,
      prefix,
      evaluator,
      shardCount: shard.count,
    });
  }
  manifest = await updateManifest(store, manifestKey, (current) => ({
    ...current,
    revision: evaluator.revision,
    activeScorers: scorerNames,
    dataSealed: true,
  }));

  const experiment: Experiment | null = options.noSendLogs
    ? null
    : initExperiment({
        state: evaluator.state,
        ...(evaluator.projectId
          ? { projectId: evaluator.projectId }
          : { project: projectName }),
        experiment: manifest.value.experimentName,
        update: manifest.value.experimentName !== undefined,
        description: evaluator.description,
        metadata: evaluator.metadata,
        tags: evaluator.tags,
        setCurrent: false,
      });

  if (experiment && !manifest.value.experimentName) {
    const summary = await experiment.summarize({ summarizeScores: false });
    manifest = await updateManifest(store, manifestKey, (current) => ({
      ...current,
      experimentName: summary.experimentName,
    }));
  }

  await reconcileScorers(store, prefix, scorerNames);

  if (options.operation === "retry-failed") {
    await resetStages(store, prefix, scorerNames, "failed");
  } else if (options.operation === "resubmit-unknown") {
    await resetStages(store, prefix, scorerNames, "unknown");
  } else if (options.operation === "cancel") {
    await cancelRun({
      store,
      prefix,
      evaluator,
      scorerDefinitions,
      runId,
      shard,
      signal: options.signal ?? new AbortController().signal,
    });
  }

  if (options.operation === "status" || options.operation === "cancel") {
    if (options.operation === "cancel" && experiment) {
      await flushPendingLogs({
        store,
        prefix,
        experiment,
        scorerNames,
        shard,
        runId,
      });
      await experiment.flush();
    }
    const progress = await collectProgress(store, prefix, scorerNames);
    const complete = await isComplete(store, prefix, scorerNames);
    if (!complete) {
      return pausedResult(runId, "status_only", progress, (overrides = {}) =>
        runDurableEval(projectName, evaluator, {
          ...options,
          ...overrides,
          operation: "run",
          runId,
          store,
          shard,
        }),
      );
    }
    return {
      status: "completed",
      runId,
      summary: await buildLocalDurableSummary(
        store,
        prefix,
        projectName,
        manifest.value.experimentName ?? evalName,
        scorerNames,
      ),
      progress,
      failures: {
        tasks: progress.taskFailed,
        scorers: progress.scoreFailed,
      },
    };
  }

  const startedAt = Date.now();
  const deadlineAt =
    options.deadlineMs === undefined
      ? undefined
      : startedAt + Math.max(options.deadlineMs, 0);
  const controller = new AbortController();
  const abortHandler = () => controller.abort();
  options.signal?.addEventListener("abort", abortHandler, { once: true });

  const resume = (overrides: Partial<DurableEvalRuntimeOptions> = {}) =>
    runDurableEval(projectName, evaluator, {
      ...options,
      ...overrides,
      runId,
      store,
      shard,
      operation: "run",
    });

  try {
    while (true) {
      if (options.signal?.aborted) {
        return pausedResult(
          runId,
          "aborted",
          await collectProgress(store, prefix, scorerNames),
          resume,
        );
      }
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        return pausedResult(
          runId,
          "deadline",
          await collectProgress(store, prefix, scorerNames),
          resume,
        );
      }

      let changed = false;
      changed =
        (await runTaskPass({
          store,
          prefix,
          projectName,
          evalName,
          evaluator,
          shard,
          workerId,
          runId,
          signal: controller.signal,
        })) || changed;
      for (const scorer of scorerDefinitions) {
        changed =
          (await runScorePass({
            store,
            prefix,
            projectName,
            evalName,
            scorer,
            evaluatorRevision: evaluator.revision,
            shard,
            workerId,
            runId,
            signal: controller.signal,
          })) || changed;
      }

      if (experiment) {
        changed =
          (await flushPendingLogs({
            store,
            prefix,
            experiment,
            scorerNames,
            shard,
            runId,
          })) || changed;
      }

      const progress = await collectProgress(store, prefix, scorerNames);
      if (progress.unknown > 0) {
        return pausedResult(runId, "unknown_submission", progress, resume);
      }
      const shardComplete = await isComplete(
        store,
        prefix,
        scorerNames,
        shard.index,
      );
      const globallyComplete = await isComplete(store, prefix, scorerNames);
      if (globallyComplete) {
        if (experiment) {
          await experiment.flush();
        }
        const summary = experiment
          ? await experiment.summarize()
          : await buildLocalDurableSummary(
              store,
              prefix,
              projectName,
              manifest.value.experimentName ?? evalName,
              scorerNames,
            );
        return {
          status: "completed",
          runId,
          summary,
          progress,
          failures: {
            tasks: progress.taskFailed,
            scorers: progress.scoreFailed,
          },
        };
      }
      if (shardComplete && shard.count > 1) {
        return pausedResult(runId, "shard_complete", progress, resume);
      }
      if (!changed && (await hasProviderErrorJob(store, prefix, shard.index))) {
        return pausedResult(runId, "provider_unreachable", progress, resume);
      }
      if (
        !changed &&
        (await hasWaitingWebhookJob(store, prefix, shard.index, webhookStages))
      ) {
        return pausedResult(runId, "waiting_for_webhook", progress, resume);
      }
      if (!changed) {
        await delay(Math.min(timeRemaining(deadlineAt) ?? 1_000, 1_000));
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
  }
}

function pausedResult(
  runId: string,
  reason: DurableEvalPauseReason,
  progress: DurableEvalProgress,
  resume: (
    overrides?: Partial<DurableEvalRuntimeOptions>,
  ) => Promise<DurableEvalResult>,
): DurableEvalResult {
  return { status: "paused", runId, reason, progress, resume };
}

function emptyProgress(): DurableEvalProgress {
  return {
    total: 0,
    taskPending: 0,
    taskSucceeded: 0,
    taskFailed: 0,
    scorePending: 0,
    scoreSucceeded: 0,
    scoreFailed: 0,
    unknown: 0,
  };
}

async function initializeManifest(
  store: DurableEvalStore,
  key: string,
  initial: DurableRunManifest,
): Promise<Versioned<DurableRunManifest>> {
  const existing = await readJson<DurableRunManifest>(store, key);
  if (existing) return existing;
  const result = await writeJson(store, key, initial, { ifAbsent: true });
  if (result.written) return { value: initial, version: result.version };
  const raced = await readJson<DurableRunManifest>(store, key);
  if (!raced) throw new Error("DurableEval manifest initialization failed");
  return raced;
}

async function updateManifest(
  store: DurableEvalStore,
  key: string,
  update: (manifest: DurableRunManifest) => DurableRunManifest,
) {
  while (true) {
    const current = await readJson<DurableRunManifest>(store, key);
    if (!current) throw new Error("DurableEval manifest is missing");
    const next = update(current.value);
    const result = await writeJson(store, key, next, {
      ifVersion: current.version,
    });
    if (result.written) return { value: next, version: result.version };
  }
}

async function materializeData<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>({
  store,
  prefix,
  evaluator,
  shardCount,
}: {
  store: DurableEvalStore;
  prefix: string;
  evaluator: DurableEvaluator<Input, Output, Expected, Metadata, Parameters>;
  shardCount: number;
}) {
  const rawData =
    typeof evaluator.data === "function" ? evaluator.data() : evaluator.data;
  const resolved = rawData instanceof Promise ? await rawData : rawData;
  if (
    typeof resolved === "object" &&
    resolved !== null &&
    "_type" in resolved
  ) {
    throw new Error(
      "DurableEval does not yet support BaseExperiment data sources",
    );
  }
  if (!isIterable(resolved) && !isAsyncIterable(resolved)) {
    throw new Error("DurableEval data must be an iterable or async iterable");
  }

  const seen = new Set<string>();
  for await (const datum of toAsyncIterable(resolved)) {
    const caseId =
      datum.id ??
      datum.upsert_id ??
      (evaluator.caseId ? await evaluator.caseId(datum) : undefined);
    if (!caseId || typeof caseId !== "string") {
      throw new Error(
        "Every DurableEval case must have a non-empty id/upsert_id or be resolved by caseId",
      );
    }
    if (seen.has(caseId)) {
      throw new Error(`Duplicate DurableEval case id: ${caseId}`);
    }
    seen.add(caseId);

    const trialCount = datum.trialCount ?? evaluator.trialCount ?? 1;
    if (!Number.isInteger(trialCount) || trialCount < 1) {
      throw new Error(`Invalid trialCount for DurableEval case ${caseId}`);
    }
    for (let trialIndex = 0; trialIndex < trialCount; trialIndex++) {
      const id = workItemId(caseId, trialIndex);
      const record: DurableCaseRecord = {
        id,
        caseId,
        trialIndex,
        shard: stableShard(id, shardCount),
        datum: assertJsonValue(datum, `case ${caseId}`),
        task: { status: "pending", attempts: 0 },
        scores: {},
        metadata: assertJsonValue(
          "metadata" in datum ? datum.metadata : {},
          `case ${caseId} metadata`,
        ),
        tags: datum.tags,
      };
      const key = caseKey(prefix, id);
      const result = await writeJson(store, key, record, { ifAbsent: true });
      if (!result.written) {
        const existing = await readJson<DurableCaseRecord>(store, key);
        if (
          !existing ||
          stableStringify(existing.value.datum) !==
            stableStringify(record.datum)
        ) {
          throw new Error(
            `DurableEval case ${caseId} changed while the run was being prepared`,
          );
        }
      }
    }
  }
}

type ResolvedScorer = {
  name: string;
  revision: string;
  // Runtime orchestration intentionally erases user generics after public
  // type-checking at the DurableEval boundary.
  scorer: // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | EvalScorer<any, any, any, any>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | DurableBatchScorer<any, any, any, any, JsonValue>;
};

function resolveScorers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scorers: DurableEvaluator<any, any, any, any, any>["scores"],
): ResolvedScorer[] {
  return scorers.map((scorer) => {
    if (isBatchScorer(scorer)) {
      if (!scorer.name.trim()) {
        throw new Error("DurableEval batch scorers must have a name");
      }
      return { name: scorer.name, revision: scorer.revision, scorer };
    }
    if (!scorer.name) {
      throw new Error("DurableEval scorers must be named functions");
    }
    return { name: scorer.name, revision: "unversioned", scorer };
  });
}

async function reconcileScorers(
  store: DurableEvalStore,
  prefix: string,
  scorerNames: string[],
) {
  for await (const record of listCases(store, prefix)) {
    const missing = scorerNames.filter(
      (name) => record.value.scores[name] === undefined,
    );
    if (!missing.length) continue;
    const next = structuredClone(record.value);
    for (const name of missing) {
      next.scores[name] = { status: "pending", attempts: 0 };
    }
    await writeJson(store, caseKey(prefix, record.value.id), next, {
      ifVersion: record.version,
    });
  }
}

async function resetStages(
  store: DurableEvalStore,
  prefix: string,
  scorerNames: string[],
  status: "failed" | "unknown",
) {
  for await (const current of listCases(store, prefix)) {
    const next = structuredClone(current.value);
    let changed = false;
    if (next.task.status === status) {
      next.task = {
        status: "pending",
        attempts: next.task.attempts,
      };
      changed = true;
    }
    for (const name of scorerNames) {
      const state = next.scores[name];
      if (state?.status === status) {
        next.scores[name] = {
          status: "pending",
          attempts: state.attempts,
        };
        changed = true;
      }
    }
    if (changed) {
      await writeJson(store, caseKey(prefix, next.id), next, {
        ifVersion: current.version,
      });
    }
  }
}

async function cancelRun({
  store,
  prefix,
  evaluator,
  scorerDefinitions,
  runId,
  shard,
  signal,
}: {
  store: DurableEvalStore;
  prefix: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator: DurableEvaluator<any, any, any, any, any>;
  scorerDefinitions: ResolvedScorer[];
  runId: string;
  shard: { index: number; count: number };
  signal: AbortSignal;
}) {
  const processors = new Map<
    string,
    DurableBatchProcessor<unknown, unknown, JsonValue>
  >();
  if (isBatchTask(evaluator.task)) {
    processors.set(
      "task",
      evaluator.task as DurableBatchProcessor<unknown, unknown, JsonValue>,
    );
  }
  for (const definition of scorerDefinitions) {
    if (isBatchScorer(definition.scorer)) {
      processors.set(
        `score:${definition.name}`,
        definition.scorer as DurableBatchProcessor<unknown, unknown, JsonValue>,
      );
    }
  }

  for await (const key of store.list(`${prefix}/jobs/`)) {
    const current = await readJson<DurableJobRecord>(store, key);
    if (!current || current.value.shard !== shard.index) continue;
    const job = structuredClone(current.value);
    const processor = processors.get(job.stage);
    if (
      job.status === "submitted" &&
      job.handle !== undefined &&
      processor?.cancel
    ) {
      await processor.cancel(
        job.handle,
        batchContext(runId, job.stage, job, shard, signal),
      );
    }
    if (
      job.status === "preparing" ||
      job.status === "submitting" ||
      job.status === "submitted" ||
      job.status === "unknown"
    ) {
      job.status = "failed";
      job.error = { name: "CancelledError", message: "Durable eval cancelled" };
      delete job.workerId;
      delete job.leaseUntil;
      await writeJson(store, key, job, { ifVersion: current.version });
    }
  }

  for await (const current of listCases(store, prefix)) {
    if (current.value.shard !== shard.index) continue;
    const next = structuredClone(current.value);
    let changed = false;
    if (!isTerminal(next.task)) {
      next.task = {
        status: "failed",
        attempts: next.task.attempts,
        revision: evaluator.revision,
        error: {
          name: "CancelledError",
          message: "Durable eval cancelled",
        },
      };
      changed = true;
    }
    if (next.task.status === "succeeded") {
      for (const definition of scorerDefinitions) {
        const state = next.scores[definition.name];
        if (!isTerminal(state)) {
          next.scores[definition.name] = {
            status: "failed",
            attempts: state?.attempts ?? 0,
            revision: definition.revision,
            error: {
              name: "CancelledError",
              message: "Durable eval cancelled",
            },
          };
          changed = true;
        }
      }
    }
    if (changed) {
      next.logPending = true;
      await writeJson(store, caseKey(prefix, next.id), next, {
        ifVersion: current.version,
      });
    }
  }
}

async function runTaskPass({
  store,
  prefix,
  projectName,
  evalName,
  evaluator,
  shard,
  workerId,
  runId,
  signal,
}: {
  store: DurableEvalStore;
  prefix: string;
  projectName: string;
  evalName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluator: DurableEvaluator<any, any, any, any, any>;
  shard: { index: number; count: number };
  workerId: string;
  runId: string;
  signal: AbortSignal;
}) {
  const task = evaluator.task;
  if (isBatchTask(task)) {
    return await runBatchStage({
      store,
      prefix,
      projectName,
      evalName,
      processor: task,
      stage: "task",
      kind: "task",
      shard,
      workerId,
      runId,
      signal,
      makeItem: (record) => taskBatchItem(record, evaluator.parameters ?? {}),
      applyResult: (record, result, revision, attempt) =>
        applyTaskResult(
          record,
          result,
          revision,
          attempt,
          task.maxAttempts ?? 3,
        ),
    });
  }
  const localTask = task as EvalTask<
    unknown,
    unknown,
    unknown,
    Record<string, unknown>,
    EvalParameters
  >;

  let changed = false;
  for await (const current of listCases(store, prefix)) {
    if (
      current.value.shard !== shard.index ||
      !isClaimable(current.value.task)
    ) {
      continue;
    }
    const claimed = structuredClone(current.value);
    claimed.task = {
      status: "leased",
      attempts: current.value.task.attempts,
      workerId,
      leaseUntil: Date.now() + 60_000,
    };
    const claim = await writeJson(
      store,
      caseKey(prefix, current.value.id),
      claimed,
      { ifVersion: current.version },
    );
    if (!claim.written) continue;
    const datum = current.value.datum as EvalCase<
      unknown,
      unknown,
      BaseMetadata
    >;
    const attempt = current.value.task.attempts + 1;
    const next = structuredClone(current.value);
    try {
      let metadata = { ...(current.value.metadata as Record<string, unknown>) };
      const hooks: EvalHooks<
        unknown,
        Record<string, unknown>,
        EvalParameters
      > = {
        meta: (value) => {
          metadata = { ...metadata, ...(value as Record<string, unknown>) };
        },
        metadata,
        expected: "expected" in datum ? datum.expected : undefined,
        span: NOOP_SPAN,
        parameters: evaluator.parameters ?? {},
        reportProgress: () => undefined,
        trialIndex: current.value.trialIndex,
        tags: current.value.tags,
      };
      const output = await localTask(datum.input, hooks);
      next.metadata = assertJsonValue(hooks.metadata, "task metadata");
      next.tags = hooks.tags;
      next.task = {
        status: "succeeded",
        attempts: attempt,
        revision: evaluator.revision,
        value: assertJsonValue(output, "task output"),
      };
    } catch (error) {
      next.task =
        attempt < 3
          ? { status: "pending", attempts: attempt }
          : {
              status: "failed",
              attempts: attempt,
              revision: evaluator.revision,
              error: serializeError(error),
            };
    }
    next.logPending = true;
    const result = await writeJson(
      store,
      caseKey(prefix, current.value.id),
      next,
      { ifVersion: claim.version },
    );
    changed = result.written || changed;
  }
  return changed;
}

async function runScorePass({
  store,
  prefix,
  projectName,
  evalName,
  scorer,
  shard,
  workerId,
  runId,
  signal,
}: {
  store: DurableEvalStore;
  prefix: string;
  projectName: string;
  evalName: string;
  scorer: ResolvedScorer;
  evaluatorRevision: string;
  shard: { index: number; count: number };
  workerId: string;
  runId: string;
  signal: AbortSignal;
}) {
  if (isBatchScorer(scorer.scorer)) {
    const batchScorer = scorer.scorer;
    return await runBatchStage({
      store,
      prefix,
      projectName,
      evalName,
      processor: batchScorer,
      stage: `score:${scorer.name}`,
      kind: "score",
      scorerName: scorer.name,
      shard,
      workerId,
      runId,
      signal,
      eligible: (record) => record.task.status === "succeeded",
      makeItem: (record) => scorerBatchItem(record),
      applyResult: (record, result, revision, attempt) =>
        applyScoreResult(
          record,
          scorer.name,
          result,
          revision,
          attempt,
          batchScorer.maxAttempts ?? 3,
        ),
    });
  }

  let changed = false;
  for await (const current of listCases(store, prefix)) {
    const state = current.value.scores[scorer.name];
    if (
      current.value.shard !== shard.index ||
      current.value.task.status !== "succeeded" ||
      !isClaimable(state)
    ) {
      continue;
    }
    const claimed = structuredClone(current.value);
    claimed.scores[scorer.name] = {
      status: "leased",
      attempts: state.attempts,
      workerId,
      leaseUntil: Date.now() + 60_000,
    };
    const claim = await writeJson(
      store,
      caseKey(prefix, current.value.id),
      claimed,
      { ifVersion: current.version },
    );
    if (!claim.written) continue;
    const datum = current.value.datum as EvalCase<
      unknown,
      unknown,
      BaseMetadata
    >;
    const attempt = state.attempts + 1;
    const next = structuredClone(current.value);
    try {
      const raw = await scorer.scorer({
        input: datum.input,
        expected: "expected" in datum ? datum.expected : undefined,
        metadata: current.value.metadata as BaseMetadata,
        output: current.value.task.value,
      });
      next.scores[scorer.name] = {
        status: "succeeded",
        attempts: attempt,
        revision: scorer.revision,
        value: assertJsonValue(
          normalizeScores(raw, scorer.name),
          `scorer ${scorer.name} output`,
        ),
      };
    } catch (error) {
      next.scores[scorer.name] =
        attempt < 3
          ? { status: "pending", attempts: attempt }
          : {
              status: "failed",
              attempts: attempt,
              revision: scorer.revision,
              error: serializeError(error),
            };
    }
    next.logPending = true;
    const result = await writeJson(
      store,
      caseKey(prefix, current.value.id),
      next,
      { ifVersion: claim.version },
    );
    changed = result.written || changed;
  }
  return changed;
}

async function runBatchStage<Item, Result, Handle extends JsonValue>({
  store,
  prefix,
  projectName,
  evalName,
  processor,
  stage,
  kind,
  scorerName,
  shard,
  workerId,
  runId,
  signal,
  eligible = () => true,
  makeItem,
  applyResult,
}: {
  store: DurableEvalStore;
  prefix: string;
  projectName: string;
  evalName: string;
  processor: DurableBatchProcessor<Item, Result, Handle>;
  stage: string;
  kind: "task" | "score";
  scorerName?: string;
  shard: { index: number; count: number };
  workerId: string;
  runId: string;
  signal: AbortSignal;
  eligible?: (record: DurableCaseRecord) => boolean;
  makeItem: (record: DurableCaseRecord) => Item;
  applyResult: (
    record: DurableCaseRecord,
    result: Result,
    revision: string,
    attempt: number,
  ) => DurableCaseRecord;
}) {
  const batchSize = processor.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxConcurrentBatches =
    processor.maxConcurrentBatches ?? DEFAULT_MAX_CONCURRENT_BATCHES;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`Invalid batchSize for durable stage ${stage}`);
  }
  if (!Number.isInteger(maxConcurrentBatches) || maxConcurrentBatches < 1) {
    throw new Error(`Invalid maxConcurrentBatches for durable stage ${stage}`);
  }

  let changed = false;
  let activeJobs = 0;
  for await (const current of listJobs(store, prefix, stage)) {
    let job = current.value;
    if (job.shard !== shard.index) {
      continue;
    }
    if (job.status === "preparing") {
      activeJobs++;
      if ((job.leaseUntil ?? 0) > Date.now()) continue;
      const preparationError = new Error(
        "Batch preparation lease expired before provider submission",
      );
      await retryBatchItems({
        store,
        prefix,
        job,
        scorerName,
        processor,
        error: preparationError,
        retryable: true,
      });
      job.status = "failed";
      job.error = serializeError(preparationError);
      delete job.workerId;
      delete job.leaseUntil;
      await writeJson(store, current.key, job, {
        ifVersion: current.version,
      });
      activeJobs--;
      changed = true;
      continue;
    }
    if (!["submitting", "submitted"].includes(job.status)) continue;

    const completion = processor.completion;
    const fallback =
      completion.mode === "webhook" ? completion.pollFallback : undefined;
    const fallbackReady =
      fallback !== undefined &&
      Date.now() >= (job.submittedAt ?? Date.now()) + fallback.afterMs;
    const needsProviderCheck =
      job.status === "submitting" ||
      job.outcome !== undefined ||
      completion.mode === "poll" ||
      fallbackReady;

    if (!needsProviderCheck) {
      activeJobs++;
      continue;
    }
    if ((job.leaseUntil ?? 0) > Date.now()) {
      activeJobs++;
      continue;
    }

    const claimedJob = {
      ...job,
      workerId,
      leaseUntil: Date.now() + JOB_LEASE_MS,
    };
    const jobClaim = await writeJson(store, current.key, claimedJob, {
      ifVersion: current.version,
    });
    if (!jobClaim.written) continue;
    job = claimedJob;
    let jobVersion = current.version;
    jobVersion = jobClaim.version;
    const context = batchContext(runId, stage, job, shard, signal);
    let handle = job.handle as Handle | undefined;
    if (!handle) {
      const recovery = processor.recover
        ? await processor.recover(context)
        : { status: "unknown" as const };
      if (recovery.status === "found") {
        handle = recovery.handle;
        const external = externalBatchReference(processor, handle, context);
        const recovered = await persistSubmittedJob({
          store,
          jobKey: current.key,
          handle: assertJsonValue(handle, `${stage} batch handle`),
          external,
          submittedAt: job.submittedAt ?? Date.now(),
        });
        job = recovered.value;
        jobVersion = recovered.version;
        const locator = batchLocator({
          projectName,
          evalName,
          runId,
          prefix,
          jobKey: current.key,
          job,
          shardCount: shard.count,
        });
        if (external) {
          await registerExternalBatchLocator(store, external, locator);
        }
        await attachPendingWebhookEvents(store, current.key, job);
        const latest = await readJson<DurableJobRecord>(store, current.key);
        if (latest) {
          job = latest.value;
          jobVersion = latest.version;
        }
        changed = true;
      } else if (recovery.status === "not_found") {
        await retryBatchItems({
          store,
          prefix,
          job,
          scorerName,
          processor,
          error: new Error("Provider confirmed batch was not submitted"),
          retryable: true,
        });
        job.status = "failed";
        delete job.workerId;
        delete job.leaseUntil;
        await writeJson(store, current.key, job, {
          ifVersion: jobVersion,
        });
        changed = true;
        continue;
      } else {
        await markBatchUnknown(store, prefix, job, scorerName);
        job.status = "unknown";
        delete job.workerId;
        delete job.leaseUntil;
        await writeJson(store, current.key, job, {
          ifVersion: jobVersion,
        });
        changed = true;
        continue;
      }
    }

    let poll: DurableBatchPoll | undefined = job.outcome;
    if (
      job.nextPollAt &&
      job.nextPollAt > Date.now() &&
      (!fallbackReady || job.outcome !== undefined)
    ) {
      activeJobs++;
      delete job.workerId;
      delete job.leaseUntil;
      await writeJson(store, current.key, job, {
        ifVersion: jobVersion,
      });
      continue;
    }
    if (!poll) {
      const poller =
        completion.mode === "poll"
          ? completion
          : fallbackReady
            ? fallback
            : undefined;
      if (!poller) {
        activeJobs++;
        delete job.workerId;
        delete job.leaseUntil;
        await writeJson(store, current.key, job, {
          ifVersion: jobVersion,
        });
        continue;
      }
      try {
        poll = await poller.poll(handle, context);
        delete job.error;
      } catch (error) {
        activeJobs++;
        job.nextPollAt = Date.now() + (poller.intervalMs ?? 10_000);
        job.error = serializeError(error);
        delete job.workerId;
        delete job.leaseUntil;
        await writeJson(store, current.key, job, {
          ifVersion: jobVersion,
        });
        continue;
      }
    }
    if (poll.status === "pending") {
      activeJobs++;
      delete job.error;
      job.nextPollAt =
        Date.now() +
        (poll.retryAfterMs ??
          (completion.mode === "poll"
            ? completion.intervalMs
            : fallback?.intervalMs) ??
          10_000);
      delete job.workerId;
      delete job.leaseUntil;
      await writeJson(store, current.key, job, {
        ifVersion: jobVersion,
      });
      continue;
    }
    if (poll.status === "failed") {
      await retryBatchItems({
        store,
        prefix,
        job,
        scorerName,
        processor,
        error: poll.error,
        retryable: poll.retryable ?? false,
      });
      job.status = "failed";
      job.error = serializeError(poll.error);
      delete job.workerId;
      delete job.leaseUntil;
      await writeJson(store, current.key, job, {
        ifVersion: jobVersion,
      });
      await markWebhookApplied(store, job);
      changed = true;
      continue;
    }

    try {
      delete job.error;
      const seen = new Set<string>();
      const collected = await processor.collect(handle, context);
      for await (const result of toAsyncIterable(collected)) {
        const resultId = resultItemId(result);
        if (seen.has(resultId) || !job.itemIds.includes(resultId)) {
          throw new Error(
            `Batch stage ${stage} returned an unknown or duplicate item id ${resultId}`,
          );
        }
        seen.add(resultId);
        const caseRecord = await readJson<DurableCaseRecord>(
          store,
          caseKey(prefix, resultId),
        );
        if (
          !caseRecord ||
          !stageBelongsToJob(caseRecord.value, job.kind, job.id, scorerName)
        ) {
          continue;
        }
        const next = applyResult(
          structuredClone(caseRecord.value),
          result,
          job.revision,
          job.attempt,
        );
        next.logPending = true;
        await writeJson(store, caseKey(prefix, resultId), next, {
          ifVersion: caseRecord.version,
        });
      }
      for (const itemId of job.itemIds) {
        if (seen.has(itemId)) continue;
        const caseRecord = await readJson<DurableCaseRecord>(
          store,
          caseKey(prefix, itemId),
        );
        if (
          !caseRecord ||
          !stageBelongsToJob(caseRecord.value, job.kind, job.id, scorerName)
        ) {
          continue;
        }
        const missing = {
          id: itemId,
          error: new Error(`Batch stage ${stage} returned no result`),
          retryable: true,
        } as Result;
        const next = applyResult(
          structuredClone(caseRecord.value),
          missing,
          job.revision,
          job.attempt,
        );
        next.logPending = true;
        await writeJson(store, caseKey(prefix, itemId), next, {
          ifVersion: caseRecord.version,
        });
      }
    } catch (error) {
      activeJobs++;
      job.error = serializeError(error);
      job.nextPollAt = Date.now() + 10_000;
      delete job.workerId;
      delete job.leaseUntil;
      await writeJson(store, current.key, job, {
        ifVersion: jobVersion,
      });
      changed = true;
      continue;
    }
    job.status = "complete";
    delete job.workerId;
    delete job.leaseUntil;
    await writeJson(store, current.key, job, {
      ifVersion: jobVersion,
    });
    await markWebhookApplied(store, job);
    changed = true;
  }

  if (activeJobs >= maxConcurrentBatches) {
    return changed;
  }
  const ready: Versioned<DurableCaseRecord>[] = [];
  let attempts: number | undefined;
  for await (const record of listCases(store, prefix)) {
    if (record.value.shard !== shard.index || !eligible(record.value)) continue;
    const state =
      kind === "task" ? record.value.task : record.value.scores[scorerName!];
    if (isClaimable(state)) {
      attempts ??= state.attempts;
      if (state.attempts !== attempts) continue;
      ready.push(record);
      if (ready.length >= batchSize) break;
    }
  }
  if (!ready.length) return changed;

  const attempt = (attempts ?? 0) + 1;
  const batchId = deterministicId(
    `${projectName}:${evalName}:${runId}:${stage}:${ready
      .map((record) => record.value.id)
      .join(",")}:${attempt}`,
  );
  let job: DurableJobRecord = {
    id: batchId,
    stage,
    kind,
    scorerName,
    itemIds: ready.map((record) => record.value.id),
    attempt,
    revision: processor.revision,
    shard: shard.index,
    status: "preparing",
    workerId,
    leaseUntil: Date.now() + JOB_LEASE_MS,
  };
  const jobKey = `${prefix}/jobs/${encodeURIComponent(stage)}/${batchId}`;
  const created = await writeJson(store, jobKey, job, { ifAbsent: true });
  if (!created.written) return changed;
  await registerBatchLocator(
    store,
    batchLocator({
      projectName,
      evalName,
      runId,
      prefix,
      jobKey,
      job,
      shardCount: shard.count,
    }),
  );

  const claimed: Versioned<DurableCaseRecord>[] = [];
  for (const record of ready) {
    const next = structuredClone(record.value);
    const state: StageState = {
      status: "in_batch",
      attempts: attempt,
      batchId,
      revision: processor.revision,
    };
    if (kind === "task") next.task = state;
    else next.scores[scorerName!] = state;
    const claim = await writeJson(
      store,
      caseKey(prefix, record.value.id),
      next,
      {
        ifVersion: record.version,
      },
    );
    if (claim.written) claimed.push(record);
  }
  job.itemIds = claimed.map((record) => record.value.id);
  if (!claimed.length) {
    job.status = "failed";
    job.error = serializeError(new Error("Batch lost all item claims"));
    delete job.workerId;
    delete job.leaseUntil;
    await writeJson(store, jobKey, job, {
      ifVersion: created.version,
    });
    return changed;
  }

  job.status = "submitting";
  const prepared = await writeJson(store, jobKey, job, {
    ifVersion: created.version,
  });
  if (!prepared.written) return changed;

  const context = batchContext(runId, stage, job, shard, signal);
  const items = claimed.map((record) => makeItem(record.value));
  try {
    const handle = await processor.submit(items, context);
    const external = externalBatchReference(processor, handle, context);
    const submitted = await persistSubmittedJob({
      store,
      jobKey,
      handle: assertJsonValue(handle, `${stage} batch handle`),
      external,
      submittedAt: Date.now(),
    });
    job = submitted.value;
    const locator = batchLocator({
      projectName,
      evalName,
      runId,
      prefix,
      jobKey,
      job,
      shardCount: shard.count,
    });
    if (external) {
      await registerExternalBatchLocator(store, external, locator);
    }
    await attachPendingWebhookEvents(store, jobKey, job);
  } catch (error) {
    if (error instanceof DurableEvalNotSubmittedError) {
      await retryBatchItems({
        store,
        prefix,
        job,
        scorerName,
        processor,
        error,
        retryable: true,
      });
      job.status = "failed";
      job.error = serializeError(error);
    } else {
      await markBatchUnknown(store, prefix, job, scorerName);
      job.status = "unknown";
      job.error = serializeError(error);
    }
    delete job.workerId;
    delete job.leaseUntil;
    await writeJson(store, jobKey, job, {
      ifVersion: prepared.version,
    });
  }
  return true;
}

function taskBatchItem(
  record: DurableCaseRecord,
  parameters: Record<string, unknown>,
): DurableBatchTaskItem<unknown, unknown, BaseMetadata, EvalParameters> {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  return {
    id: record.id,
    input: datum.input,
    expected: "expected" in datum ? datum.expected : undefined,
    metadata: record.metadata as BaseMetadata,
    tags: record.tags,
    parameters,
    trialIndex: record.trialIndex,
  };
}

function scorerBatchItem(
  record: DurableCaseRecord,
): DurableBatchScorerItem<unknown, unknown, unknown, Record<string, unknown>> {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  if (record.task.status !== "succeeded") {
    throw new Error("Cannot score a task that has not succeeded");
  }
  return {
    id: record.id,
    input: datum.input,
    output: record.task.value,
    expected: "expected" in datum ? datum.expected : undefined,
    metadata: record.metadata as Record<string, unknown>,
    trialIndex: record.trialIndex,
  };
}

function applyTaskResult(
  record: DurableCaseRecord,
  result: DurableBatchTaskResult<unknown, BaseMetadata>,
  revision: string,
  attempt: number,
  maxAttempts: number,
) {
  if ("error" in result) {
    record.task =
      (result.retryable ?? false) && attempt < maxAttempts
        ? { status: "pending", attempts: attempt }
        : {
            status: "failed",
            attempts: attempt,
            revision,
            error: serializeError(result.error),
          };
  } else {
    record.task = {
      status: "succeeded",
      attempts: attempt,
      revision,
      value: assertJsonValue(result.output, "batch task output"),
    };
    if (result.metadata !== undefined) {
      record.metadata = assertJsonValue(result.metadata, "batch task metadata");
    }
    if (result.tags !== undefined) record.tags = result.tags;
  }
  return record;
}

function applyScoreResult(
  record: DurableCaseRecord,
  scorerName: string,
  result: DurableBatchScorerResult,
  revision: string,
  attempt: number,
  maxAttempts: number,
) {
  if ("error" in result) {
    record.scores[scorerName] =
      (result.retryable ?? false) && attempt < maxAttempts
        ? { status: "pending", attempts: attempt }
        : {
            status: "failed",
            attempts: attempt,
            revision,
            error: serializeError(result.error),
          };
  } else {
    record.scores[scorerName] = {
      status: "succeeded",
      attempts: attempt,
      revision,
      value: assertJsonValue(
        normalizeScores(result.score, scorerName),
        `batch scorer ${scorerName} output`,
      ),
    };
  }
  return record;
}

async function retryBatchItems<Handle extends JsonValue>({
  store,
  prefix,
  job,
  scorerName,
  processor,
  error,
  retryable,
}: {
  store: DurableEvalStore;
  prefix: string;
  job: DurableJobRecord;
  scorerName?: string;
  processor: DurableBatchProcessor<unknown, unknown, Handle>;
  error: unknown;
  retryable: boolean;
}) {
  for (const itemId of job.itemIds) {
    const current = await readJson<DurableCaseRecord>(
      store,
      caseKey(prefix, itemId),
    );
    if (!current) continue;
    const next = structuredClone(current.value);
    if (!stageBelongsToJob(next, job.kind, job.id, scorerName)) {
      continue;
    }
    const state =
      retryable && job.attempt < (processor.maxAttempts ?? 3)
        ? ({ status: "pending", attempts: job.attempt } satisfies StageState)
        : ({
            status: "failed",
            attempts: job.attempt,
            revision: job.revision,
            error: serializeError(error),
          } satisfies StageState);
    if (job.kind === "task") next.task = state;
    else next.scores[scorerName!] = state;
    next.logPending = true;
    await writeJson(store, caseKey(prefix, itemId), next, {
      ifVersion: current.version,
    });
  }
}

async function markBatchUnknown(
  store: DurableEvalStore,
  prefix: string,
  job: DurableJobRecord,
  scorerName?: string,
) {
  for (const itemId of job.itemIds) {
    const current = await readJson<DurableCaseRecord>(
      store,
      caseKey(prefix, itemId),
    );
    if (!current) continue;
    const next = structuredClone(current.value);
    if (!stageBelongsToJob(next, job.kind, job.id, scorerName)) continue;
    const state: StageState = {
      status: "unknown",
      attempts: job.attempt,
      revision: job.revision,
      batchId: job.id,
    };
    if (job.kind === "task") next.task = state;
    else next.scores[scorerName!] = state;
    await writeJson(store, caseKey(prefix, itemId), next, {
      ifVersion: current.version,
    });
  }
}

function stageBelongsToJob(
  record: DurableCaseRecord,
  kind: "task" | "score",
  batchId: string,
  scorerName?: string,
) {
  const state = kind === "task" ? record.task : record.scores[scorerName ?? ""];
  return (
    (state?.status === "in_batch" || state?.status === "unknown") &&
    state.batchId === batchId
  );
}

function batchLocator({
  projectName,
  evalName,
  runId,
  prefix,
  jobKey,
  job,
  shardCount,
}: {
  projectName: string;
  evalName: string;
  runId: string;
  prefix: string;
  jobKey: string;
  job: DurableJobRecord;
  shardCount: number;
}): DurableBatchLocator {
  return {
    schemaVersion: CHECKPOINT_VERSION,
    projectName,
    evalName,
    runId,
    prefix,
    jobKey,
    batchId: job.id,
    stage: job.stage,
    kind: job.kind,
    scorerName: job.scorerName,
    shard: job.shard,
    shardCount,
  };
}

async function registerBatchLocator(
  store: DurableEvalStore,
  locator: DurableBatchLocator,
) {
  await registerLocator(store, internalBatchIndexKey(locator.batchId), locator);
}

async function registerExternalBatchLocator(
  store: DurableEvalStore,
  external: { source: string; id: string },
  locator: DurableBatchLocator,
) {
  await registerLocator(
    store,
    externalBatchIndexKey(external.source, external.id),
    locator,
  );
}

async function registerLocator(
  store: DurableEvalStore,
  key: string,
  locator: DurableBatchLocator,
) {
  const inserted = await writeJson(store, key, locator, { ifAbsent: true });
  if (inserted.written) return;
  const existing = await readJson<DurableBatchLocator>(store, key);
  if (!existing || existing.value.jobKey !== locator.jobKey) {
    throw new Error(
      `Durable batch index collision for batch ${locator.batchId}`,
    );
  }
}

function externalBatchReference<Item, Result, Handle extends JsonValue>(
  processor: DurableBatchProcessor<Item, Result, Handle>,
  handle: Handle,
  context: DurableBatchContext,
) {
  if (processor.completion.mode !== "webhook") return undefined;
  if (!processor.completion.source.trim()) {
    throw new Error("Durable batch webhook source must be non-empty");
  }
  const id = processor.completion.externalId(handle, context);
  if (!id.trim()) {
    throw new Error("Durable batch webhook externalId must be non-empty");
  }
  return { source: processor.completion.source, id };
}

async function persistSubmittedJob({
  store,
  jobKey,
  handle,
  external,
  submittedAt,
}: {
  store: DurableEvalStore;
  jobKey: string;
  handle: JsonValue;
  external?: { source: string; id: string };
  submittedAt: number;
}): Promise<Versioned<DurableJobRecord>> {
  while (true) {
    const current = await readJson<DurableJobRecord>(store, jobKey);
    if (!current) {
      throw new Error("Durable batch job disappeared during submission");
    }
    if (
      current.value.handle !== undefined &&
      stableStringify(current.value.handle) !== stableStringify(handle)
    ) {
      throw new Error(
        `Durable batch ${current.value.id} recovered with a different handle`,
      );
    }
    if (
      current.value.external &&
      external &&
      (current.value.external.source !== external.source ||
        current.value.external.id !== external.id)
    ) {
      throw new Error(
        `Durable batch ${current.value.id} resolved to a different external job`,
      );
    }
    if (
      current.value.status === "complete" ||
      current.value.status === "failed"
    ) {
      return current;
    }
    const next: DurableJobRecord = {
      ...current.value,
      status: "submitted",
      handle,
      external: external ?? current.value.external,
      submittedAt: current.value.submittedAt ?? submittedAt,
      nextPollAt: Date.now(),
    };
    delete next.workerId;
    delete next.leaseUntil;
    const written = await writeJson(store, jobKey, next, {
      ifVersion: current.version,
    });
    if (written.written) {
      return { value: next, version: written.version };
    }
  }
}

function batchProcessorForLocator<
  Input,
  Output,
  Expected,
  Metadata extends BaseMetadata,
  Parameters extends EvalParameters,
>(
  evaluator: DurableEvaluator<Input, Output, Expected, Metadata, Parameters>,
  locator: DurableBatchLocator,
): DurableBatchProcessor<unknown, unknown, JsonValue> | undefined {
  if (locator.kind === "task") {
    return isBatchTask(evaluator.task)
      ? (evaluator.task as DurableBatchProcessor<unknown, unknown, JsonValue>)
      : undefined;
  }
  const scorer = evaluator.scores.find(
    (candidate) =>
      isBatchScorer(candidate) && candidate.name === locator.scorerName,
  );
  return scorer as
    | DurableBatchProcessor<unknown, unknown, JsonValue>
    | undefined;
}

async function attachWebhookEventToJob(
  store: DurableEvalStore,
  jobKey: string,
  storedEventKey: string,
  event: DurableBatchResultEvent,
): Promise<"attached" | "duplicate" | "missing"> {
  while (true) {
    const current = await readJson<DurableJobRecord>(store, jobKey);
    if (!current) return "missing";
    if (
      current.value.status === "complete" ||
      current.value.status === "failed"
    ) {
      return "duplicate";
    }
    if (current.value.webhookEventKey === storedEventKey) {
      const next = {
        ...current.value,
        nextPollAt: Date.now(),
      };
      delete next.error;
      delete next.workerId;
      delete next.leaseUntil;
      const written = await writeJson(store, jobKey, next, {
        ifVersion: current.version,
      });
      if (written.written) return "attached";
      continue;
    }
    if (current.value.webhookEventKey) return "duplicate";
    if (
      event.handle !== undefined &&
      current.value.handle !== undefined &&
      stableStringify(event.handle) !== stableStringify(current.value.handle)
    ) {
      throw new Error(
        `Webhook handle does not match durable batch ${current.value.id}`,
      );
    }
    if (
      event.externalId &&
      current.value.external &&
      (current.value.external.source !== event.source ||
        current.value.external.id !== event.externalId)
    ) {
      throw new Error(
        `Webhook externalId does not match durable batch ${current.value.id}`,
      );
    }
    const handle = event.handle ?? current.value.handle;
    const next: DurableJobRecord = {
      ...current.value,
      handle,
      external: event.externalId
        ? { source: event.source, id: event.externalId }
        : current.value.external,
      outcome: event.outcome,
      webhookEventKey: storedEventKey,
      nextPollAt: Date.now(),
      ...(handle !== undefined
        ? {
            status: "submitted",
            submittedAt: current.value.submittedAt ?? Date.now(),
          }
        : {}),
    };
    delete next.workerId;
    delete next.leaseUntil;
    const written = await writeJson(store, jobKey, next, {
      ifVersion: current.version,
    });
    if (written.written) return "attached";
  }
}

async function attachPendingWebhookEvents(
  store: DurableEvalStore,
  jobKey: string,
  job: DurableJobRecord,
) {
  if (!job.external) return;
  for await (const pointerKey of store.list(
    webhookMailboxPrefix(job.external.source, job.external.id),
  )) {
    const pointer = await readJson<{ eventKey: string }>(store, pointerKey);
    if (!pointer) continue;
    const event = await readJson<DurableWebhookEventRecord>(
      store,
      pointer.value.eventKey,
    );
    if (!event || event.value.status === "applied") continue;
    const attached = await attachWebhookEventToJob(
      store,
      jobKey,
      pointer.value.eventKey,
      event.value.event,
    );
    if (attached !== "attached") {
      await markWebhookEventApplied(store, pointer.value.eventKey, job.id);
    }
  }
}

async function markWebhookApplied(
  store: DurableEvalStore,
  job: DurableJobRecord,
) {
  if (job.webhookEventKey) {
    await markWebhookEventApplied(store, job.webhookEventKey, job.id);
  }
}

async function markWebhookEventApplied(
  store: DurableEvalStore,
  eventKey: string,
  batchId: string,
) {
  while (true) {
    const current = await readJson<DurableWebhookEventRecord>(store, eventKey);
    if (!current || current.value.status === "applied") return;
    const next: DurableWebhookEventRecord = {
      ...current.value,
      status: "applied",
      batchId,
    };
    const written = await writeJson(store, eventKey, next, {
      ifVersion: current.version,
    });
    if (written.written) return;
  }
}

async function hasWaitingWebhookJob(
  store: DurableEvalStore,
  prefix: string,
  shard: number,
  webhookStages: Set<string>,
) {
  for await (const key of store.list(`${prefix}/jobs/`)) {
    const job = await readJson<DurableJobRecord>(store, key);
    if (
      job?.value.shard === shard &&
      job.value.status === "submitted" &&
      job.value.outcome === undefined &&
      webhookStages.has(job.value.stage)
    ) {
      return true;
    }
  }
  return false;
}

async function hasProviderErrorJob(
  store: DurableEvalStore,
  prefix: string,
  shard: number,
) {
  for await (const key of store.list(`${prefix}/jobs/`)) {
    const job = await readJson<DurableJobRecord>(store, key);
    if (
      job?.value.shard === shard &&
      job.value.status === "submitted" &&
      job.value.error !== undefined
    ) {
      return true;
    }
  }
  return false;
}

async function flushPendingLogs({
  store,
  prefix,
  experiment,
  scorerNames,
  shard,
  runId,
}: {
  store: DurableEvalStore;
  prefix: string;
  experiment: Experiment;
  scorerNames: string[];
  shard: { index: number; count: number };
  runId: string;
}) {
  let changed = false;
  for await (const current of listCases(store, prefix)) {
    if (current.value.shard !== shard.index || !current.value.logPending) {
      continue;
    }
    await logDurableCase(experiment, current.value, scorerNames, runId);
    await experiment.flush();
    const latest = await readJson<DurableCaseRecord>(
      store,
      caseKey(prefix, current.value.id),
    );
    if (latest) {
      const next = structuredClone(latest.value);
      next.logPending = false;
      const result = await writeJson(
        store,
        caseKey(prefix, current.value.id),
        next,
        { ifVersion: latest.version },
      );
      changed = result.written || changed;
    }
  }
  return changed;
}

async function logDurableCase(
  experiment: Experiment,
  record: DurableCaseRecord,
  scorerNames: string[],
  runId: string,
) {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  const rootSpanId = deterministicId(`${runId}:${record.id}:root`);
  const root = _internalStartSpanWithInitialMerge({
    parent: await experiment.export(),
    spanId: rootSpanId,
    name: "eval",
    spanAttributes: { type: SpanTypeAttribute.EVAL },
    event: {
      id: deterministicId(`${runId}:${record.id}:row`),
      input: datum.input,
      expected: "expected" in datum ? datum.expected : undefined,
      metadata: {
        ...(record.metadata as Record<string, unknown>),
        durable_eval: {
          run_id: runId,
          case_id: record.caseId,
          trial_index: record.trialIndex,
        },
      },
      tags: record.tags,
      ...(record.task.status === "succeeded"
        ? { output: record.task.value }
        : record.task.status === "failed"
          ? { error: record.task.error.message }
          : {}),
      scores: collectedScores(record, scorerNames),
    },
    state: evaluatorState(experiment),
  });
  const parent = await root.export();
  if (record.task.status === "succeeded" || record.task.status === "failed") {
    const task = _internalStartSpanWithInitialMerge({
      parent,
      spanId: deterministicId(`${runId}:${record.id}:task-span`),
      name: "task",
      spanAttributes: { type: SpanTypeAttribute.TASK },
      event: {
        id: deterministicId(`${runId}:${record.id}:task-row`),
        input: datum.input,
        metadata: {
          durable_eval: {
            revision: record.task.revision,
            attempts: record.task.attempts,
          },
        },
        ...(record.task.status === "succeeded"
          ? { output: record.task.value }
          : { error: record.task.error.message }),
      },
      state: evaluatorState(experiment),
    });
    task.end();
  }
  for (const scorerName of scorerNames) {
    const state = record.scores[scorerName];
    if (state?.status !== "succeeded" && state?.status !== "failed") continue;
    const scorer = _internalStartSpanWithInitialMerge({
      parent,
      spanId: deterministicId(`${runId}:${record.id}:score:${scorerName}:span`),
      name: scorerName,
      spanAttributes: { type: SpanTypeAttribute.SCORE },
      event: {
        id: deterministicId(`${runId}:${record.id}:score:${scorerName}:row`),
        input: {
          input: datum.input,
          output:
            record.task.status === "succeeded" ? record.task.value : undefined,
          expected: "expected" in datum ? datum.expected : undefined,
        },
        metadata: {
          durable_eval: {
            revision: state.revision,
            attempts: state.attempts,
          },
        },
        ...(state.status === "succeeded"
          ? {
              output: state.value,
              scores: state.value as Record<string, number | null>,
            }
          : { error: state.error.message }),
      },
      state: evaluatorState(experiment),
    });
    scorer.end();
  }
  root.end();
}

function evaluatorState(experiment: Experiment) {
  return experiment.loggingState;
}

function collectedScores(record: DurableCaseRecord, scorerNames: string[]) {
  const scores: Record<string, number | null> = {};
  for (const name of scorerNames) {
    const state = record.scores[name];
    if (state?.status === "succeeded") {
      Object.assign(scores, state.value);
    }
  }
  return scores;
}

async function collectProgress(
  store: DurableEvalStore,
  prefix: string,
  scorerNames: string[],
): Promise<DurableEvalProgress> {
  const progress: DurableEvalProgress = {
    ...emptyProgress(),
  };
  for await (const record of listCases(store, prefix)) {
    progress.total++;
    countStage(record.value.task, progress, "task");
    if (record.value.task.status === "succeeded") {
      for (const name of scorerNames) {
        countStage(record.value.scores[name], progress, "score");
      }
    }
  }
  return progress;
}

function countStage(
  state: StageState | undefined,
  progress: DurableEvalProgress,
  kind: "task" | "score",
) {
  if (!state || ["pending", "leased", "in_batch"].includes(state.status)) {
    if (kind === "task") progress.taskPending++;
    else progress.scorePending++;
  } else if (state.status === "succeeded") {
    if (kind === "task") progress.taskSucceeded++;
    else progress.scoreSucceeded++;
  } else if (state.status === "failed") {
    if (kind === "task") progress.taskFailed++;
    else progress.scoreFailed++;
  } else if (state.status === "unknown") {
    progress.unknown++;
  }
}

async function isComplete(
  store: DurableEvalStore,
  prefix: string,
  scorerNames: string[],
  shard?: number,
) {
  for await (const record of listCases(store, prefix)) {
    if (shard !== undefined && record.value.shard !== shard) continue;
    if (!isTerminal(record.value.task)) return false;
    if (record.value.task.status === "succeeded") {
      for (const name of scorerNames) {
        if (!isTerminal(record.value.scores[name])) return false;
      }
    }
  }
  return true;
}

function isTerminal(state: StageState | undefined) {
  return state?.status === "succeeded" || state?.status === "failed";
}

function isClaimable(state: StageState | undefined) {
  return (
    state?.status === "pending" ||
    (state?.status === "leased" && state.leaseUntil <= Date.now())
  );
}

async function buildLocalDurableSummary(
  store: DurableEvalStore,
  prefix: string,
  projectName: string,
  experimentName: string,
  scorerNames: string[],
): Promise<ExperimentSummary> {
  const totals: Record<string, { total: number; count: number }> = {};
  for await (const record of listCases(store, prefix)) {
    for (const [name, score] of Object.entries(
      collectedScores(record.value, scorerNames),
    )) {
      if (score === null) continue;
      const current = totals[name] ?? { total: 0, count: 0 };
      current.total += score;
      current.count++;
      totals[name] = current;
    }
  }
  return {
    projectName,
    experimentName,
    scores: Object.fromEntries(
      Object.entries(totals).map(([name, value]) => [
        name,
        {
          name,
          score: value.total / value.count,
          improvements: 0,
          regressions: 0,
        },
      ]),
    ),
  };
}

function normalizeScores(
  value: OneOrMoreScores,
  defaultName: string,
): Record<string, number | null> {
  if (value === null) return { [defaultName]: null };
  if (typeof value === "number") return { [defaultName]: value };
  const values = Array.isArray(value) ? value : [value];
  return Object.fromEntries(
    values.map((score: Score) => [score.name ?? defaultName, score.score]),
  );
}

function batchContext(
  runId: string,
  stage: string,
  job: DurableJobRecord,
  shard: { index: number; count: number },
  signal: AbortSignal,
): DurableBatchContext {
  return {
    runId,
    stage,
    revision: job.revision,
    shard,
    attempt: job.attempt,
    batchId: job.id,
    itemCount: job.itemIds.length,
    signal,
  };
}

function resultItemId(value: unknown): string {
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
): value is DurableBatchTask<
  unknown,
  unknown,
  unknown,
  BaseMetadata,
  EvalParameters,
  JsonValue
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === BATCH_TASK_KIND
  );
}

function isBatchScorer(
  value: unknown,
): value is DurableBatchScorer<
  unknown,
  unknown,
  unknown,
  BaseMetadata,
  JsonValue
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === BATCH_SCORER_KIND
  );
}

async function* listCases(
  store: DurableEvalStore,
  prefix: string,
): AsyncGenerator<Versioned<DurableCaseRecord>> {
  for await (const key of store.list(`${prefix}/cases/`)) {
    const record = await readJson<DurableCaseRecord>(store, key);
    if (record) yield record;
  }
}

async function* listJobs(
  store: DurableEvalStore,
  prefix: string,
  stage: string,
): AsyncGenerator<Versioned<DurableJobRecord> & { key: string }> {
  for await (const key of store.list(
    `${prefix}/jobs/${encodeURIComponent(stage)}/`,
  )) {
    const record = await readJson<DurableJobRecord>(store, key);
    if (record) yield { ...record, key };
  }
}

function runPrefix(projectName: string, evalName: string, runId: string) {
  return `durable-eval/v1/${contentVersion(
    encoder.encode(`${projectName}\0${evalName}\0${runId}`),
  )}`;
}

function internalBatchIndexKey(batchId: string) {
  return `durable-eval/v1/indices/batches/${contentVersion(
    encoder.encode(batchId),
  )}`;
}

function externalBatchIndexKey(source: string, externalId: string) {
  return `durable-eval/v1/indices/external/${contentVersion(
    encoder.encode(`${source}\0${externalId}`),
  )}`;
}

function webhookEventKey(source: string, eventId: string) {
  return `durable-eval/v1/webhooks/events/${contentVersion(
    encoder.encode(`${source}\0${eventId}`),
  )}`;
}

function webhookMailboxPrefix(source: string, externalId: string) {
  return `durable-eval/v1/webhooks/mailboxes/${contentVersion(
    encoder.encode(`${source}\0${externalId}`),
  )}/`;
}

function webhookMailboxKey(
  source: string,
  externalId: string,
  eventKey: string,
) {
  return `${webhookMailboxPrefix(source, externalId)}${contentVersion(
    encoder.encode(eventKey),
  )}`;
}

function caseKey(prefix: string, id: string) {
  return `${prefix}/cases/${encodeURIComponent(id)}`;
}

function workItemId(caseId: string, trialIndex: number) {
  return `${caseId}:trial:${trialIndex}`;
}

function stableShard(id: string, count: number) {
  const hash = contentVersion(encoder.encode(id));
  return Number.parseInt(hash.slice(0, 8), 16) % count;
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

async function readJson<T>(
  store: DurableEvalStore,
  key: string,
): Promise<Versioned<T> | undefined> {
  const record = await store.read(key);
  if (!record) return undefined;
  return {
    value: JSON.parse(decoder.decode(record.value)) as T,
    version: record.version,
  };
}

async function writeJson<T>(
  store: DurableEvalStore,
  key: string,
  value: T,
  condition: DurableEvalWriteCondition,
) {
  return await store.write(
    key,
    encoder.encode(stableStringify(value)),
    condition,
  );
}

function stableStringify(value: unknown): string {
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
    if (serialized === undefined) {
      throw new Error("value serializes to undefined");
    }
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new Error(`${label} must be JSON serializable`, { cause: error });
  }
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function isErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function validateShard(shard: { index: number; count: number }) {
  if (
    !Number.isInteger(shard.index) ||
    !Number.isInteger(shard.count) ||
    shard.count < 1 ||
    shard.index < 0 ||
    shard.index >= shard.count
  ) {
    throw new Error(`Invalid DurableEval shard ${shard.index}/${shard.count}`);
  }
}

function isIterable<T>(value: unknown): value is Iterable<T> {
  return (
    typeof value === "object" && value !== null && Symbol.iterator in value
  );
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

async function* toAsyncIterable<T>(
  value: Iterable<T> | AsyncIterable<T>,
): AsyncGenerator<T> {
  if (isAsyncIterable<T>(value)) {
    for await (const item of value) yield item;
  } else {
    for (const item of value) yield item;
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

function timeRemaining(deadlineAt: number | undefined) {
  return deadlineAt === undefined
    ? undefined
    : Math.max(deadlineAt - Date.now(), 0);
}
