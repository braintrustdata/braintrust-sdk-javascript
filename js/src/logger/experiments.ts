/// <reference lib="dom" />
import { debugLogger } from "../debug-logger";
import {
  ExperimentEvent,
  ExperimentLogFullArgs,
  LogFeedbackFullArgs,
  mergeGitMetadataSettings,
  SpanObjectTypeV3,
  SpanTypeAttribute,
  isObject,
} from "../util";
import type { GitMetadataSettings, RepoInfo } from "../sdk-types";
import iso from "#braintrust-platform";
import {
  getCurrentUnixTimestamp,
  isEmpty,
  LazyValue,
  runCatchFinally,
} from "../util";
import {
  FullLoginOptions,
  BraintrustState,
  _internalGetGlobalState,
  ProjectExperimentMetadata,
  validateTags,
  Exportable,
  enrichAttachments,
  ObjectMetadata,
  validateAndSanitizeExperimentLogFullArgs,
  Span,
  StartSpanArgs,
  SetCurrentArg,
  withCurrent,
  logError,
  SpanImpl,
  startSpanParentArgs,
  FailedHTTPResponse,
  logFeedbackImpl,
  updateSpanImpl,
  getSpanComponentsClass,
  DefaultMetadataType,
  EvalCase,
} from "./core";
import {
  AnyDataset,
  DatasetRef,
  Dataset,
  serializeDatasetForExperiment,
} from "./datasets";
import { RemoteEvalParameters } from "./prompts";
import { ObjectFetcher } from "./objects";

type InitOpenOption<IsOpen extends boolean> = {
  open?: IsOpen;
};

export interface ParametersRef {
  id: string;
  version?: string;
}

export type InitOptions<IsOpen extends boolean> = FullLoginOptions & {
  experiment?: string;
  description?: string;
  dataset?: AnyDataset | DatasetRef;
  _internal_btql?: Record<string, unknown>;
  parameters?: ParametersRef | RemoteEvalParameters<boolean, boolean>;
  update?: boolean;
  baseExperiment?: string;
  isPublic?: boolean;
  metadata?: Record<string, unknown>;
  tags?: string[];
  gitMetadataSettings?: GitMetadataSettings;
  projectId?: string;
  baseExperimentId?: string;
  repoInfo?: RepoInfo;
  setCurrent?: boolean;
  state?: BraintrustState;
} & InitOpenOption<IsOpen>;

export type FullInitOptions<IsOpen extends boolean> = {
  project?: string;
} & InitOptions<IsOpen>;

function getExperimentDatasetFilter({
  dataset,
  _internal_btql,
}: {
  dataset?: AnyDataset | DatasetRef;
  _internal_btql?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  if (_internal_btql !== undefined) {
    return _internal_btql;
  }

  if (!(dataset instanceof Dataset)) {
    return undefined;
  }

  const datasetFilter = Reflect.get(dataset, "_internal_btql");
  return isObject(datasetFilter) ? datasetFilter : undefined;
}

type InitializedExperiment<IsOpen extends boolean | undefined> =
  IsOpen extends true ? ReadonlyExperiment : Experiment;

/**
 * Log in, and then initialize a new experiment in a specified project. If the project does not exist, it will be created.
 *
 * @param options Options for configuring init().
 * @param options.project The name of the project to create the experiment in. Must specify at least one of `project` or `projectId`.
 * @param options.experiment The name of the experiment to create. If not specified, a name will be generated automatically.
 * @param options.description An optional description of the experiment.
 * @param options.dataset (Optional) A dataset to associate with the experiment. You can pass in the name of the dataset (in the same project) or a dataset object (from any project).
 * @param options.update If the experiment already exists, continue logging to it. If it does not exist, creates the experiment with the specified arguments.
 * @param options.baseExperiment An optional experiment name to use as a base. If specified, the new experiment will be summarized and compared to this experiment. Otherwise, it will pick an experiment by finding the closest ancestor on the default (e.g. main) branch.
 * @param options.isPublic An optional parameter to control whether the experiment is publicly visible to anybody with the link or privately visible to only members of the organization. Defaults to private.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. In Node.js, if that is unset, will try the nearest `.env.braintrust` file in the current working directory or parent directories. If no API key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.metadata (Optional) A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings.
 * @param options.gitMetadataSettings (Optional) Settings for collecting git metadata. By default, Braintrust collects the git metadata fields allowed by your organization's git metadata settings. If those settings are absent, git metadata is not collected unless this option is set.
 * @param setCurrent If true (the default), set the global current-experiment to the newly-created one.
 * @param options.open If the experiment already exists, open it in read-only mode. Throws an error if the experiment does not already exist.
 * @param options.projectId The id of the project to create the experiment in. This takes precedence over `project` if specified.
 * @param options.baseExperimentId An optional experiment id to use as a base. If specified, the new experiment will be summarized and compared to this. This takes precedence over `baseExperiment` if specified.
 * @param options.repoInfo (Optional) Explicitly specify the git metadata for this experiment. This takes precedence over `gitMetadataSettings` if specified.
 * @param options.tags (Optional) A list of tags to attach to the experiment.
 * @returns The newly created Experiment.
 */
export function init<IsOpen extends boolean = false>(
  options: Readonly<FullInitOptions<IsOpen>>,
): InitializedExperiment<IsOpen> {
  const {
    project,
    experiment,
    description,
    dataset,
    _internal_btql,
    parameters,
    baseExperiment,
    isPublic,
    open,
    update,
    appUrl,
    apiKey,
    orgName,
    forceLogin,
    fetch,
    metadata,
    tags,
    gitMetadataSettings,
    projectId,
    baseExperimentId,
    repoInfo,
    state: stateArg,
  } = options;

  if (!project && !projectId) {
    throw new Error("Must specify at least one of project or projectId");
  }

  if (open && update) {
    throw new Error("Cannot open and update an experiment at the same time");
  }

  const state = stateArg ?? _internalGetGlobalState();
  state._internalSetTraceContextSigningSecret(apiKey);

  // Ensure unlimited queue for init() calls (experiments)
  // Experiments should never drop data
  state.enforceQueueSizeLimit(false);

  if (open) {
    if (isEmpty(experiment)) {
      throw new Error(`Cannot open an experiment without specifying its name`);
    }

    const lazyMetadata: LazyValue<ProjectExperimentMetadata> = new LazyValue(
      async () => {
        await state.login({ apiKey, appUrl, orgName, fetch, forceLogin });
        const args: Record<string, unknown> = {
          project_name: project,
          project_id: projectId,
          org_name: state.orgName,
          experiment_name: experiment,
        };

        const response = await state
          .appConn()
          .post_json("api/experiment/get", args);

        if (response.length === 0) {
          throw new Error(
            `Experiment ${experiment} not found in project ${
              projectId ?? project
            }.`,
          );
        }

        const info = response[0];
        return {
          project: {
            id: info.project_id,
            name: project ?? "UNKNOWN_PROJECT",
            fullInfo: {},
          },
          experiment: {
            id: info.id,
            name: info.name,
            fullInfo: info,
          },
        };
      },
    );

    return new ReadonlyExperiment(
      stateArg ?? _internalGetGlobalState(),
      lazyMetadata,
    ) as InitializedExperiment<IsOpen>;
  }

  const lazyMetadata: LazyValue<ProjectExperimentMetadata> = new LazyValue(
    async () => {
      await state.login({ apiKey, appUrl, orgName });
      const args: Record<string, unknown> = {
        project_name: project,
        project_id: projectId,
        org_id: state.orgId,
        update,
      };

      if (experiment) {
        args["experiment_name"] = experiment;
      }

      if (description) {
        args["description"] = description;
      }

      const repoInfoArg = await (async (): Promise<RepoInfo | undefined> => {
        if (repoInfo) {
          return repoInfo;
        }
        const mergedGitMetadataSettings =
          state.gitMetadataSettings == null
            ? (gitMetadataSettings ?? { collect: "none" as const })
            : mergeGitMetadataSettings(
                state.gitMetadataSettings,
                gitMetadataSettings ?? { collect: "all" as const },
              );
        return await iso.getRepoInfo(mergedGitMetadataSettings);
      })();

      if (repoInfoArg) {
        args["repo_info"] = repoInfoArg;
      }

      if (baseExperimentId) {
        args["base_exp_id"] = baseExperimentId;
      } else if (baseExperiment) {
        args["base_experiment"] = baseExperiment;
      } else {
        args["ancestor_commits"] = await iso.getPastNAncestors();
      }

      if (dataset !== undefined) {
        const datasetSelection = await serializeDatasetForExperiment({
          dataset,
          state,
        });
        args["dataset_id"] = datasetSelection.datasetId;
        if (datasetSelection.datasetVersion !== undefined) {
          args["dataset_version"] = datasetSelection.datasetVersion;
        }
      }

      const datasetFilter = getExperimentDatasetFilter({
        dataset,
        _internal_btql,
      });
      if (datasetFilter !== undefined) {
        args["internal_metadata"] = {
          dataset_filter: datasetFilter,
        };
      }

      if (parameters !== undefined) {
        if (RemoteEvalParameters.isParameters(parameters)) {
          args["parameters_id"] = parameters.id;
          args["parameters_version"] = parameters.version;
        } else {
          args["parameters_id"] = parameters.id;
          if (parameters.version !== undefined) {
            args["parameters_version"] = parameters.version;
          }
        }
      }

      if (isPublic !== undefined) {
        args["public"] = isPublic;
      }

      if (metadata) {
        args["metadata"] = metadata;
      }

      if (tags) {
        validateTags(tags);
        args["tags"] = tags;
      }

      let response = null;
      while (true) {
        try {
          response = await state
            .appConn()
            .post_json("api/experiment/register", args);
          break;
        } catch (e: any) {
          if (
            args["base_experiment"] &&
            `${"data" in e && e.data}`.includes("base experiment")
          ) {
            debugLogger
              .forState(state)
              .warn(`Base experiment ${args["base_experiment"]} not found.`);
            delete args["base_experiment"];
          } else {
            throw e;
          }
        }
      }

      return {
        project: {
          id: response.project.id,
          name: response.project.name,
          fullInfo: response.project,
        },
        experiment: {
          id: response.experiment.id,
          name: response.experiment.name,
          created: response.experiment.created,
          fullInfo: response.experiment,
        },
      };
    },
  );

  const ret = new Experiment(
    state,
    lazyMetadata,
    dataset !== undefined ? (dataset as AnyDataset) : undefined,
  );
  if (options.setCurrent ?? true) {
    state.currentExperiment = ret;
  }
  return ret as InitializedExperiment<IsOpen>;
}

/**
 * An experiment is a collection of logged events, such as model inputs and outputs, which represent
 * a snapshot of your application at a particular point in time. An experiment is meant to capture more
 * than just the model you use, and includes the data you use to test, pre- and post- processing code,
 * comparison metrics (scores), and any other metadata you want to include.
 *
 * Experiments are associated with a project, and two experiments are meant to be easily comparable via
 * their `inputs`. You can change the attributes of the experiments in a project (e.g. scoring functions)
 * over time, simply by changing what you log.
 *
 * You should not create `Experiment` objects directly. Instead, use the `braintrust.init()` method.
 */
export class Experiment
  extends ObjectFetcher<ExperimentEvent>
  implements Exportable
{
  private readonly lazyMetadata: LazyValue<ProjectExperimentMetadata>;
  public readonly dataset?: AnyDataset;
  private lastStartTime: number;
  private lazyId: LazyValue<string>;
  private calledStartSpan: boolean;
  private state: BraintrustState;

  // For type identification.
  public kind = "experiment" as const;
  /** @internal Cross-bundle identification without importing experiments into tracing. */
  public readonly __braintrust_experiment_marker = true;

  constructor(
    state: BraintrustState,
    lazyMetadata: LazyValue<ProjectExperimentMetadata>,
    dataset?: AnyDataset,
  ) {
    super("experiment", undefined, (r) => enrichAttachments(r, state));
    this.lazyMetadata = lazyMetadata;
    this.dataset = dataset;
    this.lastStartTime = getCurrentUnixTimestamp();
    this.lazyId = new LazyValue(() => this.id);
    this.calledStartSpan = false;
    this.state = state;
  }

  public get id(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.id;
    })();
  }

  public get loggingState(): BraintrustState {
    return this.state;
  }

  /**
   * Wait for the experiment ID to be resolved. This is useful for ensuring the ID
   * is available synchronously in child spans (for OTEL parent attributes).
   * @internal
   */
  public async _waitForId(): Promise<void> {
    await this.lazyId.get().catch(() => {
      // Ignore errors
    });
  }

  public get name(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.name;
    })();
  }

  public get project(): Promise<ObjectMetadata> {
    return (async () => {
      return (await this.lazyMetadata.get()).project;
    })();
  }

  public async _getBaseExperimentId(): Promise<string | undefined> {
    const baseExperimentId = (await this.lazyMetadata.get()).experiment
      .fullInfo["base_exp_id"];
    return typeof baseExperimentId === "string" && baseExperimentId
      ? baseExperimentId
      : undefined;
  }

  private parentObjectType() {
    return SpanObjectTypeV3.EXPERIMENT;
  }

  protected async getState(): Promise<BraintrustState> {
    // Ensure the login state is populated by awaiting lazyMetadata.
    await this.lazyMetadata.get();
    return this.state;
  }

  /**
   * Log a single event to the experiment. The event will be batched and uploaded behind the scenes.
   *
   * @param event The event to log.
   * @param event.input: The arguments that uniquely define a test case (an arbitrary, JSON serializable object). Later on, Braintrust will use the `input` to know whether two test cases are the same between experiments, so they should not contain experiment-specific state. A simple rule of thumb is that if you run the same experiment twice, the `input` should be identical.
   * @param event.output: The output of your application, including post-processing (an arbitrary, JSON serializable object), that allows you to determine whether the result is correct or not. For example, in an app that generates SQL queries, the `output` should be the _result_ of the SQL query generated by the model, not the query itself, because there may be multiple valid queries that answer a single question.
   * @param event.expected: (Optional) The ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not. Braintrust currently does not compare `output` to `expected` for you, since there are so many different ways to do that correctly. Instead, these values are just used to help you navigate your experiments while digging into analyses. However, we may later use these values to re-score outputs or fine-tune your models.
   * @param event.error: (Optional) The error that occurred, if any. If you use tracing to run an experiment, errors are automatically logged when your code throws an exception.
   * @param event.scores: A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare experiments.
   * @param event.metadata: (Optional) a dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings.
   * @param event.metrics: (Optional) a dictionary of metrics to log. The following keys are populated automatically: "start", "end".
   * @param event.id: (Optional) a unique identifier for the event. If you don't provide one, BrainTrust will generate one for you.
   * @param event.dataset_record_id: (Optional) the id of the dataset record that this event is associated with. This field is required if and only if the experiment is associated with a dataset. This field is unused and will be removed in a future version.
   * @param options Additional logging options
   * @param options.allowConcurrentWithSpans in rare cases where you need to log at the top level separately from spans on the experiment elsewhere, set this to true.
   * @returns The `id` of the logged event.
   */
  public log(
    event: Readonly<ExperimentLogFullArgs>,
    options?: { allowConcurrentWithSpans?: boolean },
  ): string {
    if (this.calledStartSpan && !options?.allowConcurrentWithSpans) {
      throw new Error(
        "Cannot run toplevel `log` method while using spans. To log to the span, call `experiment.traced` and then log with `span.log`",
      );
    }

    event = validateAndSanitizeExperimentLogFullArgs(event);
    const span = this.startSpanImpl({ startTime: this.lastStartTime, event });
    this.lastStartTime = span.end();
    return span.id;
  }

  /**
   * Create a new toplevel span underneath the experiment. The name defaults to "root".
   *
   * See {@link Span.traced} for full details.
   */
  public traced<R>(
    callback: (span: Span) => R,
    args?: StartSpanArgs & SetCurrentArg,
  ): R {
    const { setCurrent, ...argsRest } = args ?? {};
    const span = this.startSpan(argsRest);

    return runCatchFinally(
      () => {
        if (setCurrent ?? true) {
          return withCurrent(span, callback);
        } else {
          return callback(span);
        }
      },
      (error) => {
        logError(span, error);
        throw error;
      },
      () => span.end(),
    );
  }

  /**
   * Lower-level alternative to `traced`. This allows you to start a span yourself, and can be useful in situations
   * where you cannot use callbacks. However, spans started with `startSpan` will not be marked as the "current span",
   * so `currentSpan()` and `traced()` will be no-ops. If you want to mark a span as current, use `traced` instead.
   *
   * See {@link traced} for full details.
   */
  public startSpan(args?: StartSpanArgs): Span {
    this.calledStartSpan = true;
    return this.startSpanImpl(args);
  }

  private startSpanImpl(args?: StartSpanArgs): Span {
    return new SpanImpl({
      ...args,
      // Sometimes `args` gets passed directly into this function, and it contains an undefined value for `state`.
      // To ensure that we always use this experiment's state, we override the `state` argument no matter what.
      state: this.state,
      ...startSpanParentArgs({
        state: this.state,
        parent: args?.parent,
        parentObjectType: this.parentObjectType(),
        parentObjectId: this.lazyId,
        parentComputeObjectMetadataArgs: undefined,
        parentSpanIds: undefined,
        propagatedEvent: args?.propagatedEvent,
      }),
      defaultRootType: SpanTypeAttribute.EVAL,
    });
  }

  public async fetchBaseExperiment(): Promise<{ id: any; name: any } | null> {
    const state = await this.getState();
    const conn = state.appConn();

    try {
      const resp = await conn.post("/api/base_experiment/get_id", {
        id: await this.id,
      });

      const base = await resp.json();
      return {
        id: base["base_exp_id"],
        name: base["base_exp_name"],
      };
    } catch (e) {
      if (e instanceof FailedHTTPResponse && e.status === 400) {
        // No base experiment
        return null;
      } else {
        throw e;
      }
    }
  }

  /**
   * Summarize the experiment, including the scores (compared to the closest reference experiment) and metadata.
   *
   * @param options Options for summarizing the experiment.
   * @param options.summarizeScores Whether to summarize the scores. If False, only the metadata will be returned.
   * @param options.comparisonExperimentId The experiment to compare against. If None, the most recent experiment on the origin's main branch will be used.
   * @returns A summary of the experiment, including the scores (compared to the closest reference experiment) and metadata.
   */
  public async summarize(
    options: {
      readonly summarizeScores?: boolean;
      readonly comparisonExperimentId?: string;
    } = {},
  ): Promise<ExperimentSummary> {
    const {
      summarizeScores = true,
      comparisonExperimentId: comparisonExperimentIdOpt,
    } = options || {};
    let comparisonExperimentId = comparisonExperimentIdOpt;

    const state = await this.getState();
    const projectUrl = `${state.appPublicUrl}/app/${encodeURIComponent(
      state.orgName!,
    )}/p/${encodeURIComponent((await this.project).name)}`;
    const experimentUrl = `${projectUrl}/experiments/${encodeURIComponent(
      await this.name,
    )}`;

    let scores: Record<string, ScoreSummary> | undefined = undefined;
    let metrics: Record<string, MetricSummary> | undefined = undefined;
    let comparisonExperimentName = undefined;
    if (summarizeScores) {
      await this.flush();
      if (comparisonExperimentId === undefined) {
        const baseExperiment = await this.fetchBaseExperiment();
        if (baseExperiment !== null) {
          comparisonExperimentId = baseExperiment.id;
          comparisonExperimentName = baseExperiment.name;
        }
      } else {
        try {
          const comparisonExperiment = await state
            .apiConn()
            .get_json(`v1/experiment/${comparisonExperimentId}`);
          if (typeof comparisonExperiment["name"] === "string") {
            comparisonExperimentName = comparisonExperiment["name"];
          }
        } catch {
          // If the explicit comparison name lookup fails, still summarize by ID.
        }
      }

      try {
        const results = await state.apiConn().get_json(
          "/experiment-comparison2",
          {
            experiment_id: await this.id,
            base_experiment_id: comparisonExperimentId,
          },
          3,
        );

        scores = results["scores"];
        metrics = results["metrics"];
      } catch (e) {
        debugLogger
          .forState(state)
          .warn(
            `Failed to fetch experiment scores and metrics: ${e}\n\nView complete results in Braintrust or run experiment.summarize() again.`,
          );
        scores = {};
        metrics = {};
      }
    }

    return {
      projectName: (await this.project).name,
      experimentName: await this.name,
      projectId: (await this.project).id,
      experimentId: await this.id,
      projectUrl: projectUrl,
      experimentUrl: experimentUrl,
      comparisonExperimentName: comparisonExperimentName,
      scores: scores ?? {},
      metrics: metrics ?? {},
    };
  }

  /**
   * Log feedback to an event in the experiment. Feedback is used to save feedback scores, set an expected value, or add a comment.
   *
   * @param event
   * @param event.id The id of the event to log feedback for. This is the `id` returned by `log` or accessible as the `id` field of a span.
   * @param event.scores (Optional) a dictionary of numeric values (between 0 and 1) to log. These scores will be merged into the existing scores for the event.
   * @param event.expected (Optional) the ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not.
   * @param event.comment (Optional) an optional comment string to log about the event.
   * @param event.metadata (Optional) a dictionary with additional data about the feedback. If you have a `user_id`, you can log it here and access it in the Braintrust UI. Note, this metadata does not correspond to the main event itself, but rather the audit log attached to the event.
   * @param event.source (Optional) the source of the feedback. Must be one of "external" (default), "app", or "api".
   */
  public logFeedback(event: LogFeedbackFullArgs): void {
    logFeedbackImpl(this.state, this.parentObjectType(), this.lazyId, event);
  }

  /**
   * Update a span in the experiment using its id. It is important that you only update a span once the original span has been fully written and flushed,
   * since otherwise updates to the span may conflict with the original span.
   *
   * @param event The event data to update the span with. Must include `id`. See {@link Experiment.log} for a full list of valid fields.
   */
  public updateSpan(
    event: Omit<Partial<ExperimentEvent>, "id"> &
      Required<Pick<ExperimentEvent, "id">>,
  ): void {
    const { id, root_span_id, span_id, ...eventRest } = event;
    if (!id) {
      throw new Error("Span id is required to update a span");
    }
    updateSpanImpl({
      state: this.state,
      parentObjectType: this.parentObjectType(),
      parentObjectId: this.lazyId,
      id,
      root_span_id,
      span_id,
      event: eventRest,
    });
  }

  /**
   * Return a serialized representation of the experiment that can be used to start subspans in other places.
   *
   * See {@link Span.startSpan} for more details.
   */
  public async export(): Promise<string> {
    return new (getSpanComponentsClass())({
      object_type: this.parentObjectType(),
      object_id: await this.id,
    }).toStr();
  }

  /**
   * Return this experiment's Braintrust parent string (`experiment_id:<id>`) for
   * the `braintrust.parent` baggage entry, or undefined when it cannot be
   * determined synchronously.
   */
  public _getOtelParent(): string | undefined {
    const id = this.lazyId.getSync().value;
    return id ? `experiment_id:${id}` : undefined;
  }

  /**
   * Flush any pending rows to the server.
   */
  async flush(): Promise<void> {
    return await this.state.bgLogger().flush();
  }
}

/**
 * A read-only view of an experiment, initialized by passing `open: true` to `init()`.
 */
export class ReadonlyExperiment extends ObjectFetcher<ExperimentEvent> {
  constructor(
    private state: BraintrustState,
    private readonly lazyMetadata: LazyValue<ProjectExperimentMetadata>,
  ) {
    super("experiment", undefined, (r) => enrichAttachments(r, state));
  }

  public get id(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.id;
    })();
  }

  public get name(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.name;
    })();
  }

  public get loggingState(): BraintrustState {
    return this.state;
  }

  protected async getState(): Promise<BraintrustState> {
    // Ensure the login state is populated by awaiting lazyMetadata.
    await this.lazyMetadata.get();
    return this.state;
  }

  public async *asDataset<
    Input,
    Expected,
    Metadata = DefaultMetadataType,
  >(options?: {
    batchSize?: number;
  }): AsyncGenerator<EvalCase<Input, Expected, Metadata>> {
    const records = this.fetch(options);

    for await (const record of records) {
      const isRoot = record.is_root ?? record.root_span_id === record.span_id;
      if (!isRoot) {
        continue;
      }

      const { output, expected: expectedRecord, metadata } = record;
      const expected = (expectedRecord ?? output) as Expected;

      // Note: We always include expected and metadata fields to maintain type signature alignment.
      // This ensures that when the type signature includes `| null | undefined`, the fields
      // are still present in the runtime object. While this may incorrectly include fields
      // when Metadata/Expected = void, it's preferable to incorrectly excluding them when
      // the type signature expects them to be present.
      yield {
        input: record.input as Input,
        tags: record.tags,
        expected: expected as Expected,
        metadata: metadata as Metadata,
      } as unknown as EvalCase<Input, Expected, Metadata>;
    }
  }
}

/**
 * Summary of a score's performance.
 * @property name Name of the score.
 * @property score Average score across all examples.
 * @property diff Difference in score between the current and reference experiment.
 * @property improvements Number of improvements in the score.
 * @property regressions Number of regressions in the score.
 */
export interface ScoreSummary {
  name: string;
  score: number;
  diff?: number;
  improvements: number;
  regressions: number;
}

/**
 * Summary of a metric's performance.
 * @property name Name of the metric.
 * @property metric Average metric across all examples.
 * @property unit Unit label for the metric.
 * @property diff Difference in metric between the current and reference experiment.
 * @property improvements Number of improvements in the metric.
 * @property regressions Number of regressions in the metric.
 */
export interface MetricSummary {
  name: string;
  metric: number;
  unit: string;
  diff?: number;
  improvements: number;
  regressions: number;
}

/**
 * Summary of an experiment's scores and metadata.
 * @property projectName Name of the project that the experiment belongs to.
 * @property experimentName Name of the experiment.
 * @property experimentId ID of the experiment. May be `undefined` if the eval was run locally.
 * @property projectUrl URL to the project's page in the Braintrust app.
 * @property experimentUrl URL to the experiment's page in the Braintrust app.
 * @property comparisonExperimentName The experiment scores are baselined against.
 * @property scores Summary of the experiment's scores.
 */
export interface ExperimentSummary {
  projectName: string;
  experimentName: string;
  projectId?: string;
  experimentId?: string;
  projectUrl?: string;
  experimentUrl?: string;
  comparisonExperimentName?: string;
  scores: Record<string, ScoreSummary>;
  metrics?: Record<string, MetricSummary>;
}
