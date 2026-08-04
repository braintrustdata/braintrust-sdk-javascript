import { type Score, SpanTypeAttribute } from "../util/index";
import { type EvalParameters, type InferParameters } from "./eval-parameters";
import {
  type EvalData,
  type EvalHooks,
  type EvalScorer,
  type EvalScorerArgs,
  type EvalTask,
  type OneOrMoreScores,
} from "./framework";
import iso from "./isomorph";
import {
  type BaseMetadata,
  type BraintrustState,
  type DefaultMetadataType,
  type EvalCase,
  type Experiment,
  type ExperimentSummary,
  NOOP_SPAN,
  init as initExperiment,
  newId,
} from "./logger";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BATCH_TASK_KIND = "braintrust.durable.batch-task";
const BATCH_SCORER_KIND = "braintrust.durable.batch-scorer";
const CHECKPOINT_VERSION = 2;
const DEFAULT_BATCH_SIZE = 1_000;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Minimal persistence used to reconnect provider webhooks with submitted
 * batches. DurableEval does not require any Braintrust backend changes.
 */
export interface DurableEvalStore {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
}

export interface DurableBatchContext {
  runId: string;
  batchId: string;
}

export type DurableBatchPoll =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "failed"; error: unknown };

export type DurableBatchCompletion<Handle extends JsonValue> =
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

export type DurableBatchTaskResult<Output, Metadata extends BaseMetadata> =
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

export type DurableBatchScorerResult =
  | { id: string; score: OneOrMoreScores }
  | { id: string; error: unknown };

export interface DurableBatchProcessor<Item, Result, Handle extends JsonValue> {
  batchSize?: number;
  submit(items: Item[], context: DurableBatchContext): Promise<Handle>;
  completion: DurableBatchCompletion<Handle>;
  collect(handle: Handle, context: DurableBatchContext): Promise<Result[]>;
}

export interface DurableWorkflowBatchItem<Input> {
  id: string;
  input: Input;
}

export type DurableWorkflowBatchResult<Output, Metadata extends BaseMetadata> =
  | {
      id: string;
      output: Output;
      metadata?: Metadata;
      tags?: string[];
    }
  | { id: string; error: unknown };

const WORKFLOW_NODE_OUTPUT: unique symbol = Symbol("DurableWorkflowNodeOutput");

export interface DurableWorkflowNode<Output> {
  readonly [WORKFLOW_NODE_OUTPUT]: Output;
}

type DurableWorkflowNodeMap = Record<string, DurableWorkflowNode<unknown>>;

type DurableWorkflowNodeOutputs<Nodes extends DurableWorkflowNodeMap> = {
  [Name in keyof Nodes]: Nodes[Name] extends DurableWorkflowNode<infer Output>
    ? Output
    : never;
};

export interface DurableWorkflowBuilder<
  RootItem,
  Metadata extends BaseMetadata,
> {
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

export interface DurableBatchTask<
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

export interface DurableBatchScorer<
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

export type DurableEvaluator<
  Input,
  Output,
  Expected = void,
  Metadata extends BaseMetadata = DefaultMetadataType,
  Parameters extends EvalParameters = EvalParameters,
> = {
  store: DurableEvalStore;
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
  noSendLogs?: boolean;
}

export type DurableBatchResult = {
  batchId?: string;
  externalId?: string;
};

export type DurableEvalResult =
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
  start(options?: DurableEvalRuntimeOptions): Promise<DurableEvalResult>;
  status(
    options: DurableEvalRuntimeOptions & { runId: string },
  ): Promise<DurableEvalResult>;
  poll(
    options: DurableEvalRuntimeOptions & { runId: string },
  ): Promise<DurableEvalResult>;
  processBatchResult(
    result: DurableBatchResult,
    options?: Omit<DurableEvalRuntimeOptions, "runId">,
  ): Promise<DurableEvalResult>;
}

type DurableCaseRecord = {
  id: string;
  caseId: string;
  trialIndex: number;
  datum: JsonValue;
  metadata: JsonValue;
  tags?: string[];
  taskComplete: boolean;
  output?: JsonValue;
  taskNodeOutputs: Record<string, JsonValue>;
  scores: Record<string, JsonValue>;
  scoreNodeOutputs: Record<string, Record<string, JsonValue>>;
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
  status: "running" | "completed";
  summary?: ExperimentSummary;
  cases: DurableCaseRecord[];
  batches: DurableBatchRecord[];
};

type DurableBatchLocator = {
  runKey: string;
  batchId: string;
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

  start(options: DurableEvalRuntimeOptions = {}): Promise<DurableEvalResult> {
    return startDurableEval(this, options);
  }

  status(
    options: DurableEvalRuntimeOptions & { runId: string },
  ): Promise<DurableEvalResult> {
    return getDurableEvalStatus(this, options);
  }

  poll(
    options: DurableEvalRuntimeOptions & { runId: string },
  ): Promise<DurableEvalResult> {
    return pollDurableEval(this, options);
  }

  processBatchResult(
    result: DurableBatchResult,
    options: Omit<DurableEvalRuntimeOptions, "runId"> = {},
  ): Promise<DurableEvalResult> {
    return processDurableBatchResult(this, result, options);
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
  options: DurableEvalRuntimeOptions,
): Promise<DurableEvalResult> {
  const store = definition.evaluator.store;
  const runId = options.runId ?? newId();
  const key = runKey(definition.projectName, definition.evalName, runId);
  let state = await readJson<DurableRunState>(store, key);
  if (!state) {
    state = {
      schemaVersion: CHECKPOINT_VERSION,
      runId,
      projectName: definition.projectName,
      evalName: definition.evalName,
      experimentName:
        definition.evaluator.experimentName ??
        `${definition.evalName}-${runId}`,
      status: "running",
      cases: await materializeCases(definition.evaluator),
      batches: [],
    };
    await writeJson(store, key, state);
  }
  return advanceDurableEval(definition, state, store, key, options);
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
  options: DurableEvalRuntimeOptions & { runId: string },
): Promise<DurableEvalResult> {
  const store = definition.evaluator.store;
  const state = await readJson<DurableRunState>(
    store,
    runKey(definition.projectName, definition.evalName, options.runId),
  );
  if (!state) throw new Error(`DurableEval run ${options.runId} is missing`);
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
  options: Omit<DurableEvalRuntimeOptions, "runId">,
): Promise<DurableEvalResult> {
  if (!result.batchId && !result.externalId) {
    throw new Error("Batch results require batchId or externalId");
  }
  const store = definition.evaluator.store;
  const locator = await locateBatch(
    store,
    definition.projectName,
    definition.evalName,
    result,
  );
  if (!locator) {
    throw new Error("No submitted batch matches this result");
  }
  const state = await readJson<DurableRunState>(store, locator.runKey);
  if (!state)
    throw new Error(`DurableEval run for batch ${locator.batchId} is missing`);
  const batch = state.batches.find(
    (candidate) => candidate.id === locator.batchId,
  );
  if (!batch) throw new Error(`Batch ${locator.batchId} is missing`);
  if (batch.status !== "complete") {
    await collectBatch(definition, state, batch);
    batch.status = "complete";
    await writeJson(store, locator.runKey, state);
  }
  return advanceDurableEval(definition, state, store, locator.runKey, options);
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
  options: DurableEvalRuntimeOptions & { runId: string },
): Promise<DurableEvalResult> {
  const store = definition.evaluator.store;
  const key = runKey(
    definition.projectName,
    definition.evalName,
    options.runId,
  );
  const state = await readJson<DurableRunState>(store, key);
  if (!state) throw new Error(`DurableEval run ${options.runId} is missing`);

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
  return advanceDurableEval(definition, state, store, key, options);
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
  options: Omit<DurableEvalRuntimeOptions, "runId">,
): Promise<DurableEvalResult> {
  if (state.status === "completed") return currentStatus(definition, state);
  await runTaskStage(definition, state, store, key);
  if (state.cases.some((record) => !record.taskComplete)) {
    return currentStatus(definition, state);
  }

  await runScoreStages(definition, state, store, key);
  const scorerNames = resolveScorers(definition.evaluator.scores).map(
    ({ name }) => name,
  );
  if (
    state.cases.some((record) =>
      scorerNames.some((name) => !(name in record.scores)),
    )
  ) {
    return currentStatus(definition, state);
  }

  state.summary = await finishExperiment(definition, state, options.noSendLogs);
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
      throw new Error(`DurableEval run ${state.runId} has no saved summary`);
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
    const datum = record.datum as EvalCase<Input, Expected, Metadata>;
    const metadata = { ...(record.metadata as Record<string, unknown>) };
    const hooks: EvalHooks<Expected, Metadata, Parameters> = {
      meta(value) {
        Object.assign(metadata, value);
      },
      metadata: metadata as EvalHooks<
        Expected,
        Metadata,
        Parameters
      >["metadata"],
      expected: ("expected" in datum ? datum.expected : undefined) as Expected,
      span: NOOP_SPAN,
      parameters: (definition.evaluator.parameters ??
        {}) as InferParameters<Parameters>,
      reportProgress: () => undefined,
      trialIndex: record.trialIndex,
      tags: record.tags,
    };
    record.output = assertJsonValue(
      await task(datum.input, hooks),
      `task output for ${record.caseId}`,
    );
    record.metadata = assertJsonValue(hooks.metadata, "task metadata");
    record.tags = hooks.tags;
    record.taskComplete = true;
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
) {
  const scorers = resolveScorers(definition.evaluator.scores);
  for (const { name, scorer } of scorers) {
    if (isBatchScorer(scorer)) {
      await ensureWorkflowBatches(definition, state, store, key, "score", name);
      continue;
    }
    for (const record of state.cases) {
      if (name in record.scores) continue;
      const datum = record.datum as EvalCase<Input, Expected, Metadata>;
      const value = await (
        scorer as EvalScorer<Input, Output, Expected, Metadata>
      )({
        input: datum.input,
        ...(datum.tags ? { tags: datum.tags } : {}),
        ...(datum.id ? { id: datum.id } : {}),
        ...(datum.upsert_id ? { upsert_id: datum.upsert_id } : {}),
        ...(datum.trialCount ? { trialCount: datum.trialCount } : {}),
        ...("expected" in datum ? { expected: datum.expected } : {}),
        metadata: record.metadata as Metadata,
        output: record.output as Output,
      } as unknown as EvalScorerArgs<Input, Output, Expected, Metadata>);
      record.scores[name] = assertJsonValue(
        normalizeScores(value, name),
        `scorer ${name} output`,
      );
      await writeJson(store, key, state);
    }
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
        itemForNode(definition, record, kind, scorerName, node),
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
      await indexBatch(store, definition, batch, key);
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
        normalizeScores(output as OneOrMoreScores, batch.scorerName!),
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
    const scorer = resolveScorers(definition.evaluator.scores).find(
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
  definition: DurableEvalDefinition<any, any, any, any, any>,
  record: DurableCaseRecord,
  kind: "task" | "score",
  scorerName: string | undefined,
  node: DurableWorkflowNodeDefinition,
) {
  const rootItem =
    kind === "task"
      ? taskBatchItem(record, definition.evaluator.parameters ?? {})
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

async function materializeCases(
  evaluator: DurableEvaluator<any, any, any, any, any>,
): Promise<DurableCaseRecord[]> {
  const raw =
    typeof evaluator.data === "function" ? evaluator.data() : evaluator.data;
  const data = raw instanceof Promise ? await raw : raw;
  if (typeof data === "object" && data !== null && "_type" in data) {
    throw new Error("DurableEval does not support BaseExperiment data sources");
  }
  if (!isIterable(data) && !isAsyncIterable(data)) {
    throw new Error("DurableEval data must be iterable");
  }
  const records: DurableCaseRecord[] = [];
  const seen = new Set<string>();
  for await (const datum of toAsyncIterable(data)) {
    const caseId =
      datum.id ??
      datum.upsert_id ??
      (evaluator.caseId ? await evaluator.caseId(datum) : undefined);
    if (!caseId) {
      throw new Error(
        "Every DurableEval case requires id, upsert_id, or caseId",
      );
    }
    if (seen.has(caseId))
      throw new Error(`Duplicate DurableEval case id: ${caseId}`);
    seen.add(caseId);
    const trialCount = datum.trialCount ?? evaluator.trialCount ?? 1;
    if (!Number.isInteger(trialCount) || trialCount < 1) {
      throw new Error(`Invalid trialCount for DurableEval case ${caseId}`);
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
        taskNodeOutputs: {},
        scores: {},
        scoreNodeOutputs: {},
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
  noSendLogs = false,
) {
  const scorerNames = resolveScorers(definition.evaluator.scores).map(
    ({ name }) => name,
  );
  if (noSendLogs) {
    return buildLocalSummary(
      state,
      definition.projectName,
      state.experimentName,
      scorerNames,
    );
  }
  const experiment = initExperiment({
    state: definition.evaluator.state,
    ...(definition.evaluator.projectId
      ? { projectId: definition.evaluator.projectId }
      : { project: definition.projectName }),
    experiment: state.experimentName,
    update: true,
    description: definition.evaluator.description,
    metadata: definition.evaluator.metadata,
    tags: definition.evaluator.tags,
    setCurrent: false,
  });
  for (const record of state.cases) {
    logCase(experiment, state.runId, record, scorerNames);
  }
  await experiment.flush();
  return await experiment.summarize();
}

function logCase(
  experiment: Experiment,
  runId: string,
  record: DurableCaseRecord,
  scorerNames: string[],
) {
  const datum = record.datum as EvalCase<unknown, unknown, BaseMetadata>;
  const scores = Object.assign(
    {},
    ...scorerNames.map((name) => record.scores[name] ?? {}),
  ) as Record<string, number | null>;
  const span = experiment.startSpan({
    name: "eval",
    spanId: deterministicId(`${runId}:${record.id}:span`),
    spanAttributes: { type: SpanTypeAttribute.EVAL },
    event: {
      id: deterministicId(`${runId}:${record.id}:row`),
      input: datum.input,
      expected: "expected" in datum ? datum.expected : undefined,
      output: record.output,
      scores,
      metadata: {
        ...(record.metadata as Record<string, unknown>),
        durable_eval: {
          run_id: runId,
          case_id: record.caseId,
          trial_index: record.trialIndex,
        },
      },
      tags: record.tags,
    },
  });
  span.end();
}

function buildLocalSummary(
  state: DurableRunState,
  projectName: string,
  experimentName: string,
  scorerNames: string[],
): ExperimentSummary {
  const totals: Record<string, { total: number; count: number }> = {};
  for (const record of state.cases) {
    for (const scorerName of scorerNames) {
      const scores = record.scores[scorerName] as Record<string, number | null>;
      for (const [name, score] of Object.entries(scores)) {
        if (score === null) continue;
        const total = totals[name] ?? { total: 0, count: 0 };
        total.total += score;
        total.count++;
        totals[name] = total;
      }
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

function normalizeScores(value: OneOrMoreScores, defaultName: string) {
  if (value === null) return { [defaultName]: null };
  if (typeof value === "number") return { [defaultName]: value };
  const values = Array.isArray(value) ? value : [value];
  return Object.fromEntries(
    values.map((score: Score) => [score.name ?? defaultName, score.score]),
  );
}

async function indexBatch(
  store: DurableEvalStore,
  definition: DurableEvalDefinition<any, any, any, any, any>,
  batch: DurableBatchRecord,
  key: string,
) {
  const locator = { runKey: key, batchId: batch.id };
  await writeJson(
    store,
    batchIndexKey(
      definition.projectName,
      definition.evalName,
      "batch",
      batch.id,
    ),
    locator,
  );
  if (batch.externalId) {
    await writeJson(
      store,
      batchIndexKey(
        definition.projectName,
        definition.evalName,
        "external",
        batch.externalId,
      ),
      locator,
    );
  }
}

async function locateBatch(
  store: DurableEvalStore,
  projectName: string,
  evalName: string,
  result: DurableBatchResult,
) {
  const byBatch = result.batchId
    ? await readJson<DurableBatchLocator>(
        store,
        batchIndexKey(projectName, evalName, "batch", result.batchId),
      )
    : undefined;
  const byExternal = result.externalId
    ? await readJson<DurableBatchLocator>(
        store,
        batchIndexKey(projectName, evalName, "external", result.externalId),
      )
    : undefined;
  if (
    byBatch &&
    byExternal &&
    (byBatch.runKey !== byExternal.runKey ||
      byBatch.batchId !== byExternal.batchId)
  ) {
    throw new Error("batchId and externalId identify different batches");
  }
  return byBatch ?? byExternal;
}

function runKey(projectName: string, evalName: string, runId: string) {
  return `durable-eval/v2/runs/${contentVersion(encoder.encode(`${projectName}\0${evalName}\0${runId}`))}`;
}

function batchIndexKey(
  projectName: string,
  evalName: string,
  type: "batch" | "external",
  id: string,
) {
  return `durable-eval/v2/index/${contentVersion(encoder.encode(`${projectName}\0${evalName}`))}/${type}/${contentVersion(encoder.encode(id))}`;
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

async function* toAsyncIterable<T>(value: Iterable<T> | AsyncIterable<T>) {
  if (isAsyncIterable<T>(value)) {
    for await (const item of value) yield item;
  } else {
    for (const item of value) yield item;
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
