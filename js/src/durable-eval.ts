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
const LEASE_HEARTBEAT_MS = JOB_LEASE_MS / 3;
const FILE_LOCK_STALE_MS = 10_000;
const FILE_LOCK_WAIT_MS = 15_000;

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
      key.includes("\\") ||
      key.split("/").some((part) => part === ".." || part === ".")
    ) {
      throw new Error(`Invalid durable eval store key: ${key}`);
    }
    return iso.pathJoin!(this.root, ...key.split("/"));
  }

  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${path}.lock`;
    const lockContents = stableStringify({
      owner: newId(),
      createdAt: new Date().toISOString(),
    });
    await iso.mkdir!(iso.pathDirname!(path), { recursive: true });
    const started = Date.now();
    let handle:
      | { close(): Promise<void>; writeFile(value: string): Promise<void> }
      | undefined;
    while (!handle) {
      try {
        const candidate = await iso.openFile!(lockPath, "wx");
        try {
          await candidate.writeFile(lockContents);
          handle = candidate;
        } catch (error) {
          await candidate.close();
          await iso.unlink!(lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
        try {
          const lockStat = await iso.stat!(lockPath);
          if (Date.now() - lockStat.mtimeMs >= FILE_LOCK_STALE_MS) {
            await iso.unlink!(lockPath).catch((unlinkError) => {
              if (!isErrorCode(unlinkError, "ENOENT")) throw unlinkError;
            });
            continue;
          }
        } catch (statError) {
          if (!isErrorCode(statError, "ENOENT")) throw statError;
          continue;
        }
        if (Date.now() - started >= FILE_LOCK_WAIT_MS) throw error;
        await delay(10);
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      try {
        const currentLock = await iso.readFile!(lockPath);
        if (decoder.decode(currentLock) === lockContents) {
          await iso.unlink!(lockPath).catch(() => undefined);
        }
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) throw error;
      }
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
  removedScores?: string[];
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

type DurableExperimentInitRecord = {
  schemaVersion: number;
  experimentName: string;
  status: "initializing" | "ready";
  workerId?: string;
  leaseUntil?: number;
  experimentId?: string;
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
  if (attached === "in_progress") {
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
  const shard = options.shard ?? {
    index: 0,
    count: existingManifest?.value.shardCount ?? 1,
  };
  validateShard(shard);
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
      experimentName: evaluator.experimentName ?? `${evalName}-${runId}`,
      createdAt: new Date().toISOString(),
    }));
  if (manifest.value.shardCount !== shard.count) {
    throw new Error(
      `DurableEval run ${runId} was created with ${manifest.value.shardCount} shards, not ${shard.count}`,
    );
  }
  if (
    options.shard === undefined &&
    manifest.value.shardCount > 1 &&
    (options.operation === "retry-failed" ||
      options.operation === "resubmit-unknown" ||
      options.operation === "cancel")
  ) {
    let lastResult: DurableEvalResult | undefined;
    let pausedLifecycleResult: DurableEvalResult | undefined;
    for (let index = 0; index < manifest.value.shardCount; index++) {
      const result = await runDurableEval(projectName, evaluator, {
        ...options,
        runId,
        store,
        shard: { index, count: manifest.value.shardCount },
      });
      lastResult = result;
      if (
        result.status === "paused" &&
        result.reason !== "shard_complete" &&
        result.reason !== "status_only" &&
        !pausedLifecycleResult
      ) {
        pausedLifecycleResult = result;
      }
    }
    if (!lastResult) throw new Error("DurableEval sharded lifecycle failed");
    return pausedLifecycleResult ?? lastResult;
  }
  if (!manifest.value.experimentName) {
    manifest = await updateManifest(store, manifestKey, (current) => ({
      ...current,
      experimentName:
        current.experimentName ??
        evaluator.experimentName ??
        `${evalName}-${runId}`,
    }));
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
    : await initializeDurableExperiment({
        store,
        key: `${prefix}/experiment`,
        workerId,
        experimentName: manifest.value.experimentName!,
        create: () =>
          initExperiment({
            state: evaluator.state,
            ...(evaluator.projectId
              ? { projectId: evaluator.projectId }
              : { project: projectName }),
            experiment: manifest.value.experimentName,
            update: true,
            description: evaluator.description,
            metadata: evaluator.metadata,
            tags: evaluator.tags,
            setCurrent: false,
          }),
      });

  await reconcileScorers(store, prefix, scorerNames);

  if (options.operation === "retry-failed") {
    await resetStages(store, prefix, scorerNames, "failed", shard.index);
  } else if (options.operation === "resubmit-unknown") {
    await resetStages(store, prefix, scorerNames, "unknown", shard.index);
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
  const deadlineTimer =
    deadlineAt === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(),
          Math.max(deadlineAt - Date.now(), 0),
        );

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
      if (controller.signal.aborted) {
        return pausedResult(
          runId,
          options.signal?.aborted ? "aborted" : "deadline",
          progress,
          resume,
        );
      }
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
    if (deadlineTimer) clearTimeout(deadlineTimer);
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

async function initializeDurableExperiment({
  store,
  key,
  workerId,
  experimentName,
  create,
}: {
  store: DurableEvalStore;
  key: string;
  workerId: string;
  experimentName: string;
  create: () => Experiment;
}): Promise<Experiment> {
  while (true) {
    const current = await readJson<DurableExperimentInitRecord>(store, key);
    if (current?.value.status === "ready") {
      const experiment = create();
      const experimentId = await experiment.id;
      if (
        current.value.experimentId &&
        current.value.experimentId !== experimentId
      ) {
        throw new Error(
          `DurableEval experiment ${experimentName} resolved to multiple experiment IDs`,
        );
      }
      return experiment;
    }

    const now = Date.now();
    if (!current || (current.value.leaseUntil ?? 0) <= now) {
      const claimed: DurableExperimentInitRecord = {
        schemaVersion: CHECKPOINT_VERSION,
        experimentName,
        status: "initializing",
        workerId,
        leaseUntil: now + JOB_LEASE_MS,
      };
      const write = await writeJson(
        store,
        key,
        claimed,
        current ? { ifVersion: current.version } : { ifAbsent: true },
      );
      if (write.written) {
        const heartbeat = startLeaseHeartbeat(async () => {
          let renewed = false;
          await updateExperimentInitRecord(store, key, (record) => {
            if (
              record.status !== "initializing" ||
              record.workerId !== workerId
            ) {
              return undefined;
            }
            renewed = true;
            return { ...record, leaseUntil: Date.now() + JOB_LEASE_MS };
          });
          return renewed;
        });
        try {
          const experiment = create();
          const experimentId = await experiment.id;
          const finalized = await updateExperimentInitRecord(
            store,
            key,
            (record) =>
              record.status === "initializing" && record.workerId === workerId
                ? {
                    schemaVersion: CHECKPOINT_VERSION,
                    experimentName,
                    status: "ready",
                    experimentId,
                  }
                : undefined,
          );
          if (!finalized) {
            throw new Error(
              `DurableEval lost the experiment initialization lease for ${experimentName}`,
            );
          }
          return experiment;
        } catch (error) {
          await updateExperimentInitRecord(store, key, (record) =>
            record.status === "initializing" && record.workerId === workerId
              ? { ...record, leaseUntil: 0 }
              : undefined,
          );
          throw error;
        } finally {
          await heartbeat.stop();
        }
      }
    }

    await delay(25);
  }
}

async function updateExperimentInitRecord(
  store: DurableEvalStore,
  key: string,
  update: (
    record: DurableExperimentInitRecord,
  ) => DurableExperimentInitRecord | undefined,
) {
  while (true) {
    const current = await readJson<DurableExperimentInitRecord>(store, key);
    if (!current) return false;
    const next = update(structuredClone(current.value));
    if (!next) return false;
    const written = await writeJson(store, key, next, {
      ifVersion: current.version,
    });
    if (written.written) return true;
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
  const active = new Set(scorerNames);
  for await (const record of listCases(store, prefix)) {
    await updateCaseRecord(store, prefix, record.value.id, (next) => {
      const missing = scorerNames.filter(
        (name) => next.scores[name] === undefined,
      );
      const removed = Object.keys(next.scores).filter(
        (name) => !active.has(name),
      );
      if (!missing.length && !removed.length) return undefined;
      for (const name of missing) {
        next.scores[name] = { status: "pending", attempts: 0 };
      }
      const removedScoreKeys = removed.flatMap((name) => {
        const state = next.scores[name];
        return state?.status === "succeeded"
          ? typeof state.value === "object" &&
            state.value !== null &&
            !Array.isArray(state.value)
            ? Object.keys(state.value)
            : [name]
          : [];
      });
      for (const name of removed) {
        delete next.scores[name];
      }
      if (removedScoreKeys.length) {
        next.removedScores = [
          ...new Set([...(next.removedScores ?? []), ...removedScoreKeys]),
        ];
        next.logPending = true;
      }
      return next;
    });
  }
  for await (const key of store.list(`${prefix}/jobs/`)) {
    await updateJobRecord(store, key, (job) => {
      if (
        !job.stage.startsWith("score:") ||
        active.has(job.stage.slice("score:".length)) ||
        job.status === "complete" ||
        job.status === "failed"
      ) {
        return undefined;
      }
      job.status = "failed";
      job.error = {
        name: "ScorerRemovedError",
        message: `Scorer ${job.stage.slice("score:".length)} was removed`,
      };
      delete job.workerId;
      delete job.leaseUntil;
      return job;
    });
  }
}

async function resetStages(
  store: DurableEvalStore,
  prefix: string,
  scorerNames: string[],
  status: "failed" | "unknown",
  shard: number,
) {
  for await (const current of listCases(store, prefix)) {
    if (current.value.shard !== shard) continue;
    await updateCaseRecord(store, prefix, current.value.id, (next) => {
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
      return changed ? next : undefined;
    });
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
    await updateJobRecord(store, key, (latest) => {
      if (
        latest.status !== "preparing" &&
        latest.status !== "submitting" &&
        latest.status !== "submitted" &&
        latest.status !== "unknown"
      ) {
        return undefined;
      }
      latest.status = "failed";
      latest.error = {
        name: "CancelledError",
        message: "Durable eval cancelled",
      };
      delete latest.workerId;
      delete latest.leaseUntil;
      return latest;
    });
  }

  for await (const current of listCases(store, prefix)) {
    if (current.value.shard !== shard.index) continue;
    await updateCaseRecord(store, prefix, current.value.id, (next) => {
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
      if (!changed) return undefined;
      next.logPending = true;
      return next;
    });
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
      leaseUntil: Date.now() + JOB_LEASE_MS,
    };
    const claim = await writeJson(
      store,
      caseKey(prefix, current.value.id),
      claimed,
      { ifVersion: current.version },
    );
    if (!claim.written) continue;
    const heartbeat = startCaseLeaseHeartbeat({
      store,
      prefix,
      id: current.value.id,
      kind: "task",
      workerId,
    });
    const datum = current.value.datum as EvalCase<
      unknown,
      unknown,
      BaseMetadata
    >;
    const attempt = current.value.task.attempts + 1;
    let taskResult:
      | {
          status: "succeeded";
          output: JsonValue;
          metadata: JsonValue;
          tags?: string[];
        }
      | { status: "failed"; error: unknown };
    try {
      const metadata = {
        ...(current.value.metadata as Record<string, unknown>),
      };
      const hooks: EvalHooks<
        unknown,
        Record<string, unknown>,
        EvalParameters
      > = {
        meta: (value) => {
          Object.assign(metadata, value);
        },
        metadata,
        expected: "expected" in datum ? datum.expected : undefined,
        span: NOOP_SPAN,
        parameters: evaluator.parameters ?? {},
        reportProgress: () => undefined,
        trialIndex: current.value.trialIndex,
        tags: current.value.tags,
      };
      const output = await awaitWithSignal(
        Promise.resolve().then(() => localTask(datum.input, hooks)),
        signal,
      );
      taskResult = {
        status: "succeeded",
        output: assertJsonValue(output, "task output"),
        metadata: assertJsonValue(hooks.metadata, "task metadata"),
        tags: hooks.tags,
      };
    } catch (error) {
      taskResult = { status: "failed", error };
    } finally {
      await heartbeat.stop();
    }
    changed =
      (await updateCaseRecord(store, prefix, current.value.id, (next) => {
        if (next.task.status !== "leased" || next.task.workerId !== workerId) {
          return undefined;
        }
        if (signal.aborted) {
          next.task = {
            status: "pending",
            attempts: next.task.attempts,
          };
          return next;
        }
        if (taskResult.status === "succeeded") {
          next.metadata = taskResult.metadata;
          next.tags = taskResult.tags;
          next.task = {
            status: "succeeded",
            attempts: attempt,
            revision: evaluator.revision,
            value: taskResult.output,
          };
        } else {
          next.task =
            attempt < 3
              ? { status: "pending", attempts: attempt }
              : {
                  status: "failed",
                  attempts: attempt,
                  revision: evaluator.revision,
                  error: serializeError(taskResult.error),
                };
        }
        next.logPending = true;
        return next;
      })) || changed;
    if (signal.aborted) return changed;
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

  const localScorer = scorer.scorer as EvalScorer<
    unknown,
    unknown,
    unknown,
    Record<string, unknown>
  >;
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
      leaseUntil: Date.now() + JOB_LEASE_MS,
    };
    const claim = await writeJson(
      store,
      caseKey(prefix, current.value.id),
      claimed,
      { ifVersion: current.version },
    );
    if (!claim.written) continue;
    const heartbeat = startCaseLeaseHeartbeat({
      store,
      prefix,
      id: current.value.id,
      kind: "score",
      scorerName: scorer.name,
      workerId,
    });
    const datum = current.value.datum as EvalCase<
      unknown,
      unknown,
      BaseMetadata
    >;
    const attempt = state.attempts + 1;
    const taskOutput = current.value.task.value;
    let scoreResult:
      | { status: "succeeded"; value: JsonValue }
      | { status: "failed"; error: unknown };
    try {
      const raw = await awaitWithSignal(
        Promise.resolve().then(() =>
          localScorer({
            input: datum.input,
            expected: "expected" in datum ? datum.expected : undefined,
            metadata: current.value.metadata as Record<string, unknown>,
            output: taskOutput,
          }),
        ),
        signal,
      );
      scoreResult = {
        status: "succeeded",
        value: assertJsonValue(
          normalizeScores(raw, scorer.name),
          `scorer ${scorer.name} output`,
        ),
      };
    } catch (error) {
      scoreResult = { status: "failed", error };
    } finally {
      await heartbeat.stop();
    }
    changed =
      (await updateCaseRecord(store, prefix, current.value.id, (next) => {
        const latest = next.scores[scorer.name];
        if (latest?.status !== "leased" || latest.workerId !== workerId) {
          return undefined;
        }
        if (signal.aborted) {
          next.scores[scorer.name] = {
            status: "pending",
            attempts: latest.attempts,
          };
          return next;
        }
        next.scores[scorer.name] =
          scoreResult.status === "succeeded"
            ? {
                status: "succeeded",
                attempts: attempt,
                revision: scorer.revision,
                value: scoreResult.value,
              }
            : attempt < 3
              ? { status: "pending", attempts: attempt }
              : {
                  status: "failed",
                  attempts: attempt,
                  revision: scorer.revision,
                  error: serializeError(scoreResult.error),
                };
        next.logPending = true;
        return next;
      })) || changed;
    if (signal.aborted) return changed;
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
      const takeover = {
        ...job,
        workerId,
        leaseUntil: Date.now() + JOB_LEASE_MS,
      };
      const takeoverResult = await writeJson(store, current.key, takeover, {
        ifVersion: current.version,
      });
      if (!takeoverResult.written) continue;
      job = takeover;
      const preparationError = new Error(
        "Batch preparation lease expired before provider submission",
      );
      const failed = await updateJobRecord(store, current.key, (latest) => {
        if (latest.workerId !== workerId || latest.status !== "preparing") {
          return undefined;
        }
        latest.status = "failed";
        latest.error = serializeError(preparationError);
        delete latest.workerId;
        delete latest.leaseUntil;
        return latest;
      });
      if (failed?.written && failed.value.status === "failed") {
        await retryBatchItems({
          store,
          prefix,
          job,
          scorerName,
          processor,
          error: preparationError,
          retryable: true,
        });
      }
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
    const context = batchContext(runId, stage, job, shard, signal);
    let handle = job.handle as Handle | undefined;
    if (!handle) {
      let recovery: DurableBatchRecovery<Handle>;
      try {
        recovery = processor.recover
          ? await withJobLeaseHeartbeat({
              store,
              key: current.key,
              workerId,
              signal,
              operation: () => processor.recover!(context),
            })
          : { status: "unknown" };
      } catch (error) {
        await updateJobRecord(store, current.key, (latest) => {
          if (latest.workerId !== workerId) return undefined;
          latest.error = serializeError(error);
          latest.nextPollAt = Date.now() + 10_000;
          delete latest.workerId;
          delete latest.leaseUntil;
          return latest;
        });
        changed = true;
        continue;
      }
      const latest = await readJson<DurableJobRecord>(store, current.key);
      if (!latest || latest.value.workerId !== workerId) {
        changed = true;
        continue;
      }
      job = latest.value;
      if (recovery.status === "found") {
        handle = recovery.handle;
        const external = externalBatchReference(processor, handle, context);
        const recovered = await persistSubmittedJob({
          store,
          jobKey: current.key,
          workerId,
          handle: assertJsonValue(handle, `${stage} batch handle`),
          external,
          submittedAt: job.submittedAt ?? Date.now(),
        });
        job = recovered.value;
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
        }
        changed = true;
      } else if (recovery.status === "not_found") {
        const error = new Error("Provider confirmed batch was not submitted");
        const failed = await updateJobRecord(store, current.key, (latest) => {
          if (latest.workerId !== workerId) return undefined;
          latest.status = "failed";
          delete latest.workerId;
          delete latest.leaseUntil;
          return latest;
        });
        if (failed?.written && failed.value.status === "failed") {
          await retryBatchItems({
            store,
            prefix,
            job,
            scorerName,
            processor,
            error,
            retryable: true,
          });
        }
        changed = true;
        continue;
      } else {
        const unknown = await updateJobRecord(store, current.key, (latest) => {
          if (latest.workerId !== workerId) return undefined;
          latest.status = "unknown";
          delete latest.workerId;
          delete latest.leaseUntil;
          return latest;
        });
        if (unknown?.written) {
          await markBatchUnknown(store, prefix, job, scorerName);
        }
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
      await updateJobRecord(store, current.key, (latest) => {
        if (latest.workerId !== workerId) return undefined;
        delete latest.workerId;
        delete latest.leaseUntil;
        return latest;
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
        await updateJobRecord(store, current.key, (latest) => {
          if (latest.workerId !== workerId) return undefined;
          delete latest.workerId;
          delete latest.leaseUntil;
          return latest;
        });
        continue;
      }
      try {
        poll = await withJobLeaseHeartbeat({
          store,
          key: current.key,
          workerId,
          signal,
          operation: () => poller.poll(handle, context),
        });
        const latest = await readJson<DurableJobRecord>(store, current.key);
        if (!latest || latest.value.workerId !== workerId) {
          changed = true;
          continue;
        }
        job = latest.value;
        delete job.error;
      } catch (error) {
        activeJobs++;
        await updateJobRecord(store, current.key, (latest) => {
          if (latest.workerId !== workerId) return undefined;
          latest.nextPollAt = Date.now() + (poller.intervalMs ?? 10_000);
          latest.error = serializeError(error);
          delete latest.workerId;
          delete latest.leaseUntil;
          return latest;
        });
        continue;
      }
    }
    if (poll.status === "pending") {
      activeJobs++;
      await updateJobRecord(store, current.key, (latest) => {
        if (latest.workerId !== workerId) return undefined;
        delete latest.error;
        latest.nextPollAt =
          Date.now() +
          (poll.retryAfterMs ??
            (completion.mode === "poll"
              ? completion.intervalMs
              : fallback?.intervalMs) ??
            10_000);
        delete latest.workerId;
        delete latest.leaseUntil;
        return latest;
      });
      continue;
    }
    if (poll.status === "failed") {
      const failed = await updateJobRecord(store, current.key, (latest) => {
        if (latest.workerId !== workerId) return undefined;
        latest.status = "failed";
        latest.error = serializeError(poll.error);
        delete latest.workerId;
        delete latest.leaseUntil;
        return latest;
      });
      if (failed?.written && failed.value.status === "failed") {
        await retryBatchItems({
          store,
          prefix,
          job,
          scorerName,
          processor,
          error: poll.error,
          retryable: poll.retryable ?? false,
        });
        await markWebhookApplied(store, failed.value);
      }
      changed = true;
      continue;
    }

    const collectionHeartbeat = startJobLeaseHeartbeat(
      store,
      current.key,
      workerId,
    );
    try {
      delete job.error;
      const seen = new Set<string>();
      const collected = await awaitWithSignal(
        Promise.resolve().then(() => processor.collect(handle, context)),
        signal,
      );
      for await (const result of toAbortableAsyncIterable(collected, signal)) {
        const resultId = resultItemId(result);
        if (seen.has(resultId) || !job.itemIds.includes(resultId)) {
          throw new Error(
            `Batch stage ${stage} returned an unknown or duplicate item id ${resultId}`,
          );
        }
        seen.add(resultId);
        await updateCaseRecord(store, prefix, resultId, (record) => {
          if (!stageBelongsToJob(record, job.kind, job.id, scorerName)) {
            return undefined;
          }
          const next = applyResult(record, result, job.revision, job.attempt);
          next.logPending = true;
          return next;
        });
      }
      for (const itemId of job.itemIds) {
        if (seen.has(itemId)) continue;
        const missing = {
          id: itemId,
          error: new Error(`Batch stage ${stage} returned no result`),
          retryable: true,
        } as Result;
        await updateCaseRecord(store, prefix, itemId, (record) => {
          if (!stageBelongsToJob(record, job.kind, job.id, scorerName)) {
            return undefined;
          }
          const next = applyResult(record, missing, job.revision, job.attempt);
          next.logPending = true;
          return next;
        });
      }
    } catch (error) {
      activeJobs++;
      await updateJobRecord(store, current.key, (latest) => {
        if (latest.workerId !== workerId) return undefined;
        latest.error = serializeError(error);
        latest.nextPollAt = Date.now() + 10_000;
        delete latest.workerId;
        delete latest.leaseUntil;
        return latest;
      });
      changed = true;
      continue;
    } finally {
      await collectionHeartbeat.stop();
    }
    const completed = await updateJobRecord(store, current.key, (latest) => {
      if (
        latest.id !== job.id ||
        latest.status !== "submitted" ||
        latest.workerId !== workerId
      ) {
        return undefined;
      }
      latest.status = "complete";
      delete latest.workerId;
      delete latest.leaseUntil;
      delete latest.error;
      return latest;
    });
    if (completed?.value.status !== "complete") continue;
    job = completed.value;
    await markWebhookApplied(store, completed.value);
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

  const preparationHeartbeat = startJobLeaseHeartbeat(store, jobKey, workerId);
  const claimed: Versioned<DurableCaseRecord>[] = [];
  for (const record of ready) {
    if (signal.aborted) break;
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
  if (signal.aborted) {
    await preparationHeartbeat.stop();
    const failed = await updateJobRecord(store, jobKey, (latest) => {
      if (latest.workerId !== workerId || latest.status !== "preparing") {
        return undefined;
      }
      latest.itemIds = job.itemIds;
      latest.status = "failed";
      latest.error = serializeError(new DurableEvalAbortError());
      delete latest.workerId;
      delete latest.leaseUntil;
      return latest;
    });
    if (failed?.written) {
      await retryBatchItems({
        store,
        prefix,
        job,
        scorerName,
        processor,
        error: new DurableEvalAbortError(),
        retryable: true,
      });
    }
    return true;
  }
  if (!claimed.length) {
    await preparationHeartbeat.stop();
    await updateJobRecord(store, jobKey, (latest) => {
      if (latest.workerId !== workerId || latest.status !== "preparing") {
        return undefined;
      }
      latest.status = "failed";
      latest.error = serializeError(new Error("Batch lost all item claims"));
      delete latest.workerId;
      delete latest.leaseUntil;
      return latest;
    });
    return changed;
  }

  const prepared = await updateJobRecord(store, jobKey, (latest) => {
    if (latest.workerId !== workerId || latest.status !== "preparing") {
      return undefined;
    }
    latest.itemIds = job.itemIds;
    latest.status = "submitting";
    latest.leaseUntil = Date.now() + JOB_LEASE_MS;
    return latest;
  });
  await preparationHeartbeat.stop();
  if (
    !prepared ||
    !prepared.written ||
    prepared.value.status !== "submitting" ||
    prepared.value.workerId !== workerId
  ) {
    return changed;
  }
  job = prepared.value;

  const context = batchContext(runId, stage, job, shard, signal);
  const items = claimed.map((record) => makeItem(record.value));
  try {
    const handle = await withJobLeaseHeartbeat({
      store,
      key: jobKey,
      workerId,
      signal,
      operation: () => processor.submit(items, context),
    });
    const external = externalBatchReference(processor, handle, context);
    const submitted = await persistSubmittedJob({
      store,
      jobKey,
      workerId,
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
    const definitelyNotSubmitted =
      error instanceof DurableEvalNotSubmittedError;
    const terminalStatus = definitelyNotSubmitted ? "failed" : "unknown";
    const updated = await updateJobRecord(store, jobKey, (latest) => {
      if (
        latest.workerId !== workerId ||
        latest.status === "complete" ||
        latest.status === "failed" ||
        latest.webhookEventKey
      ) {
        return undefined;
      }
      latest.status = terminalStatus;
      latest.error = serializeError(error);
      delete latest.workerId;
      delete latest.leaseUntil;
      return latest;
    });
    if (
      updated?.written &&
      updated.value.status === "failed" &&
      definitelyNotSubmitted
    ) {
      await retryBatchItems({
        store,
        prefix,
        job,
        scorerName,
        processor,
        error,
        retryable: true,
      });
    } else if (
      updated?.written &&
      updated.value.status === "unknown" &&
      !definitelyNotSubmitted
    ) {
      await markBatchUnknown(store, prefix, job, scorerName);
    }
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
    await updateCaseRecord(store, prefix, itemId, (record) => {
      if (!stageBelongsToJob(record, job.kind, job.id, scorerName)) {
        return undefined;
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
      if (job.kind === "task") record.task = state;
      else record.scores[scorerName!] = state;
      record.logPending = true;
      return record;
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
    await updateCaseRecord(store, prefix, itemId, (record) => {
      if (!stageBelongsToJob(record, job.kind, job.id, scorerName)) {
        return undefined;
      }
      const state: StageState = {
        status: "unknown",
        attempts: job.attempt,
        revision: job.revision,
        batchId: job.id,
      };
      if (job.kind === "task") record.task = state;
      else record.scores[scorerName!] = state;
      return record;
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
  workerId,
  handle,
  external,
  submittedAt,
}: {
  store: DurableEvalStore;
  jobKey: string;
  workerId: string;
  handle: JsonValue;
  external?: { source: string; id: string };
  submittedAt: number;
}): Promise<Versioned<DurableJobRecord>> {
  while (true) {
    const current = await readJson<DurableJobRecord>(store, jobKey);
    if (!current) {
      throw new Error("Durable batch job disappeared during submission");
    }
    if (current.value.workerId !== workerId) {
      throw new Error("Durable batch submission lease was lost");
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
): Promise<"attached" | "duplicate" | "in_progress" | "missing"> {
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
      if (
        current.value.workerId &&
        (current.value.leaseUntil ?? 0) > Date.now()
      ) {
        return "in_progress";
      }
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
    if (attached === "duplicate") {
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
      (job.value.status === "submitting" || job.value.status === "submitted") &&
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
      (job.value.status === "submitting" || job.value.status === "submitted") &&
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
    const next = structuredClone(current.value);
    next.logPending = false;
    delete next.removedScores;
    const result = await writeJson(
      store,
      caseKey(prefix, current.value.id),
      next,
      { ifVersion: current.version },
    );
    changed = result.written || changed;
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
  for (const name of record.removedScores ?? []) {
    scores[name] = null;
  }
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

async function updateCaseRecord(
  store: DurableEvalStore,
  prefix: string,
  id: string,
  update: (record: DurableCaseRecord) => DurableCaseRecord | undefined,
) {
  while (true) {
    const current = await readJson<DurableCaseRecord>(
      store,
      caseKey(prefix, id),
    );
    if (!current) return false;
    const next = update(structuredClone(current.value));
    if (!next) return false;
    const written = await writeJson(store, caseKey(prefix, id), next, {
      ifVersion: current.version,
    });
    if (written.written) return true;
  }
}

async function updateJobRecord(
  store: DurableEvalStore,
  key: string,
  update: (record: DurableJobRecord) => DurableJobRecord | undefined,
) {
  while (true) {
    const current = await readJson<DurableJobRecord>(store, key);
    if (!current) return undefined;
    const next = update(structuredClone(current.value));
    if (!next) return { ...current, written: false as const };
    const written = await writeJson(store, key, next, {
      ifVersion: current.version,
    });
    if (written.written) {
      return { value: next, version: written.version, written: true as const };
    }
  }
}

function startCaseLeaseHeartbeat({
  store,
  prefix,
  id,
  kind,
  scorerName,
  workerId,
}: {
  store: DurableEvalStore;
  prefix: string;
  id: string;
  kind: "task" | "score";
  scorerName?: string;
  workerId: string;
}) {
  return startLeaseHeartbeat(async () => {
    const updated = await updateCaseRecord(store, prefix, id, (record) => {
      const state =
        kind === "task" ? record.task : record.scores[scorerName ?? ""];
      if (state?.status !== "leased" || state.workerId !== workerId) {
        return undefined;
      }
      state.leaseUntil = Date.now() + JOB_LEASE_MS;
      return record;
    });
    return updated;
  });
}

function startJobLeaseHeartbeat(
  store: DurableEvalStore,
  key: string,
  workerId: string,
) {
  return startLeaseHeartbeat(async () => {
    const updated = await updateJobRecord(store, key, (job) => {
      if (
        job.workerId !== workerId ||
        (job.status !== "preparing" &&
          job.status !== "submitting" &&
          job.status !== "submitted")
      ) {
        return undefined;
      }
      job.leaseUntil = Date.now() + JOB_LEASE_MS;
      return job;
    });
    return updated?.value.workerId === workerId;
  });
}

async function withJobLeaseHeartbeat<T>({
  store,
  key,
  workerId,
  signal,
  operation,
}: {
  store: DurableEvalStore;
  key: string;
  workerId: string;
  signal: AbortSignal;
  operation: () => Promise<T>;
}) {
  if (signal.aborted) throw new DurableEvalAbortError();
  const heartbeat = startJobLeaseHeartbeat(store, key, workerId);
  try {
    return await awaitWithSignal(Promise.resolve().then(operation), signal);
  } finally {
    await heartbeat.stop();
  }
}

function startLeaseHeartbeat(renew: () => Promise<boolean>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      pending = renew()
        .then((owned) => {
          if (!owned) stopped = true;
        })
        .finally(schedule);
    }, LEASE_HEARTBEAT_MS);
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pending;
    },
  };
}

function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DurableEvalAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DurableEvalAbortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

class DurableEvalAbortError extends Error {
  constructor() {
    super("Durable eval operation was aborted");
    this.name = "AbortError";
  }
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

async function* toAbortableAsyncIterable<T>(
  value: Iterable<T> | AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  if (isAsyncIterable<T>(value)) {
    const iterator = value[Symbol.asyncIterator]();
    while (true) {
      const next = await awaitWithSignal(iterator.next(), signal);
      if (next.done) return;
      yield next.value;
    }
  } else {
    for (const item of value) {
      if (signal.aborted) throw new DurableEvalAbortError();
      yield item;
    }
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
