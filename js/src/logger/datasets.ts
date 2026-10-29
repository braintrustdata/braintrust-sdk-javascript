/// <reference lib="dom" />
import { v4 as uuidv4 } from "uuid";
import {
  AnyDatasetRecord,
  BackgroundLogEvent,
  DatasetRecord,
  ensureNewDatasetRecord,
  IS_MERGE_FIELD,
  isObject,
} from "../util";
import { DatasetSnapshot as datasetSnapshotSchema } from "../sdk-schemas";
import type { DatasetSnapshot, ObjectReference } from "../sdk-types";
import { z } from "zod/v3";
import { LazyValue } from "../util";
import {
  FullLoginOptions,
  BraintrustState,
  ProjectDatasetMetadata,
  _internalGetGlobalState,
  enrichAttachments,
  ObjectMetadata,
  validateTags,
  deepCopyEvent,
} from "./core";
import { ObjectFetcher, WithTransactionId } from "./objects";

const datasetSnapshotRegisterResponseSchema = z.object({
  dataset_snapshot: datasetSnapshotSchema,
  found_existing: z.boolean().optional(),
});

const datasetObjectInfoSchema = z.object({
  object_id: z.string(),
  object_name: z.string(),
  parent_cols: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
    }),
  }),
});

const datasetRestorePreviewResultSchema = z.object({
  rows_to_restore: z.number(),
  rows_to_delete: z.number(),
});

export type DatasetRestorePreviewResult = {
  rows_to_restore: number;
  rows_to_delete: number;
};

const datasetRestoreResultSchema = z.object({
  xact_id: z.string().nullable(),
  rows_restored: z.number(),
  rows_deleted: z.number(),
});

export type DatasetRestoreResult = {
  xact_id: string | null;
  rows_restored: number;
  rows_deleted: number;
};

/**
 * Reference to a dataset by ID and optional explicit selector.
 */
export type DatasetSelection = {
  version?: string;
  environment?: string;
  snapshotName?: string;
};

type DatasetSnapshotNameLookup = {
  snapshotName: string;
  xactId?: never;
};

type DatasetSnapshotXactLookup = {
  snapshotName?: never;
  xactId: string;
};

export type DatasetSnapshotLookup =
  | DatasetSnapshotNameLookup
  | DatasetSnapshotXactLookup;

function isDatasetSnapshotNameLookup(
  lookup: DatasetSnapshotLookup,
): lookup is DatasetSnapshotNameLookup {
  return "snapshotName" in lookup;
}

function assertDatasetSnapshotLookup(lookup: {
  snapshotName?: string;
  xactId?: string;
}): asserts lookup is DatasetSnapshotLookup {
  const hasSnapshotName = lookup.snapshotName !== undefined;
  const hasXactId = lookup.xactId !== undefined;
  if (hasSnapshotName === hasXactId) {
    throw new Error("Exactly one of snapshotName or xactId must be provided");
  }
}

type DatasetPinState = {
  lazyPinnedVersion?: LazyValue<string | undefined>;
  pinnedEnvironment?: string;
  pinnedSnapshotName?: string;
};

export type DatasetRef = {
  id: string;
} & DatasetSelection;

export type InitDatasetOptions = FullLoginOptions & {
  dataset?: string;
  datasetId?: string;
  description?: string;
  version?: string;
  environment?: string;
  snapshotName?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
  state?: BraintrustState;
  _internal_btql?: Record<string, unknown>;
};

export type FullInitDatasetOptions = {
  project?: string;
} & InitDatasetOptions;

async function getDatasetSnapshots(
  params:
    | {
        state: BraintrustState;
        datasetId: string;
      }
    | ({
        state: BraintrustState;
        datasetId: string;
      } & DatasetSnapshotLookup),
): Promise<DatasetSnapshot[]> {
  const { state, datasetId } = params;
  return datasetSnapshotSchema.array().parse(
    await state.appConn().post_json("api/dataset_snapshot/get", {
      dataset_id: datasetId,
      ...("snapshotName" in params ? { name: params.snapshotName } : {}),
      ...("xactId" in params ? { xact_id: params.xactId } : {}),
    }),
  );
}

async function getDatasetSnapshot(
  params: {
    state: BraintrustState;
    datasetId: string;
  } & DatasetSnapshotLookup,
): Promise<DatasetSnapshot | undefined> {
  assertDatasetSnapshotLookup(params);
  const snapshots = await getDatasetSnapshots(params);
  if (snapshots.length > 1) {
    throw new Error(
      isDatasetSnapshotNameLookup(params)
        ? `Expected a unique dataset snapshot named "${params.snapshotName}" for ${params.datasetId}`
        : `Expected a unique dataset snapshot for xact_id "${params.xactId}" in ${params.datasetId}`,
    );
  }
  return snapshots[0];
}

function normalizeDatasetSelection({
  version,
  environment,
  snapshotName,
}: DatasetSelection): DatasetSelection {
  if (version !== undefined) {
    return { version };
  }

  if (snapshotName !== undefined) {
    return { snapshotName };
  }

  if (environment !== undefined) {
    return { environment };
  }

  return {};
}

async function resolveDatasetSnapshotName({
  state,
  datasetId,
  snapshotName,
}: {
  state: BraintrustState;
  datasetId: string;
  snapshotName: string;
}): Promise<string> {
  const match = await getDatasetSnapshot({
    state,
    datasetId,
    snapshotName,
  });
  if (match === undefined) {
    throw new Error(
      `Dataset snapshot "${snapshotName}" not found for ${datasetId}`,
    );
  }
  return match.xact_id;
}

async function resolveDatasetSnapshotNameForMetadata({
  state,
  lazyMetadata,
  snapshotName,
}: {
  state: BraintrustState;
  lazyMetadata: LazyValue<ProjectDatasetMetadata>;
  snapshotName: string;
}): Promise<string> {
  const metadata = await lazyMetadata.get();
  return await resolveDatasetSnapshotName({
    state,
    datasetId: metadata.dataset.id,
    snapshotName,
  });
}

async function resolveDatasetEnvironment({
  state,
  datasetId,
  environment,
}: {
  state: BraintrustState;
  datasetId: string;
  environment: string;
}): Promise<string> {
  const environmentObjectPath = `environment-object/dataset/${datasetId}/${encodeURIComponent(environment)}`;
  const response =
    state.orgName == null
      ? await state.apiConn().get_json(environmentObjectPath)
      : await state.apiConn().get_json(environmentObjectPath, {
          org_name: state.orgName,
        });
  return z.object({ object_version: z.string() }).parse(response)
    .object_version;
}

async function resolveDatasetEnvironmentForMetadata({
  state,
  lazyMetadata,
  environment,
}: {
  state: BraintrustState;
  lazyMetadata: LazyValue<ProjectDatasetMetadata>;
  environment: string;
}): Promise<string> {
  const metadata = await lazyMetadata.get();
  return await resolveDatasetEnvironment({
    state,
    datasetId: metadata.dataset.id,
    environment,
  });
}

export async function serializeDatasetForExperiment({
  dataset,
  state,
}: {
  dataset: AnyDataset | DatasetRef;
  state: BraintrustState;
}): Promise<{ datasetId: string; datasetVersion?: string }> {
  if (!Dataset.isDataset(dataset)) {
    const selection = normalizeDatasetSelection(dataset);

    if (selection.version !== undefined) {
      return {
        datasetId: dataset.id,
        datasetVersion: selection.version,
      };
    }

    if (selection.snapshotName !== undefined) {
      return {
        datasetId: dataset.id,
        datasetVersion: await resolveDatasetSnapshotName({
          state,
          datasetId: dataset.id,
          snapshotName: selection.snapshotName,
        }),
      };
    }

    if (selection.environment !== undefined) {
      return {
        datasetId: dataset.id,
        datasetVersion: await resolveDatasetEnvironment({
          state,
          datasetId: dataset.id,
          environment: selection.environment,
        }),
      };
    }

    return {
      datasetId: dataset.id,
    };
  }

  const evalData = await dataset.toEvalData();
  const selection = normalizeDatasetSelection({
    version: evalData.dataset_version,
    environment: evalData.dataset_environment,
    snapshotName: evalData.dataset_snapshot_name,
  });

  if (selection.version !== undefined) {
    return {
      datasetId: evalData.dataset_id,
      datasetVersion: selection.version,
    };
  }

  const datasetVersion = await dataset.version();
  if (datasetVersion !== undefined) {
    return {
      datasetId: evalData.dataset_id,
      datasetVersion,
    };
  }

  return {
    datasetId: evalData.dataset_id,
  };
}

/**
 * Initialize a dataset by name or ID. When initializing by name, the dataset and its project will be created if they do not exist.
 *
 * @param options Options for configuring initDataset().
 * @param options.project The name of the project to create the dataset in. Must specify at least one of `project` or `projectId` unless `datasetId` is provided.
 * @param options.dataset The name of the dataset to create. If not specified, a name will be generated automatically. Ignored if `datasetId` is provided.
 * @param options.datasetId The ID of an existing dataset. Takes precedence over `dataset` and does not require `project` or `projectId`.
 * @param options.description An optional description when initializing a dataset by name. Cannot be used with `datasetId`.
 * @param options.version Pin the dataset to a specific version xact_id. If `snapshotName` or `environment` are also provided, `version` takes precedence.
 * @param options.snapshotName Pin the dataset to the version captured by this named snapshot. If `environment` is also provided, `snapshotName` takes precedence.
 * @param options.environment Pin the dataset to the version tagged with this environment slug.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. In Node.js, if that is unset, will try the nearest `.env.braintrust` file in the current working directory or parent directories. If no API key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.projectId The id of the project to create the dataset in. This takes precedence over `project` if specified and is not required when `datasetId` is provided.
 * @param options.metadata A dictionary with additional data when initializing a dataset by name. Cannot be used with `datasetId`. The values in `metadata` can be any JSON-serializable type, but its keys must be strings.
 * @returns The initialized Dataset.
 */
export function initDataset(
  options: Readonly<FullInitDatasetOptions>,
): Dataset {
  const {
    project,
    dataset,
    datasetId,
    description,
    version,
    snapshotName,
    environment,
    appUrl,
    apiKey,
    orgName,
    fetch,
    forceLogin,
    projectId,
    metadata,
    state: stateArg,
    _internal_btql,
  } = options;
  if (
    datasetId !== undefined &&
    (description !== undefined || metadata !== undefined)
  ) {
    throw new Error(
      "Cannot specify description or metadata when datasetId is provided",
    );
  }

  const selection = normalizeDatasetSelection({
    version,
    environment,
    snapshotName,
  });
  const normalizedVersion = selection.version;
  const normalizedEnvironment = selection.environment;
  const normalizedSnapshotName = selection.snapshotName;

  const cliInternalBtql = globalThis.__bt_eval_internal_btql;
  const internalBtql =
    cliInternalBtql === undefined
      ? _internal_btql
      : _internal_btql === undefined
        ? cliInternalBtql
        : isObject(_internal_btql)
          ? { ...cliInternalBtql, ..._internal_btql }
          : _internal_btql;

  const state = stateArg ?? _internalGetGlobalState();

  const lazyMetadata: LazyValue<ProjectDatasetMetadata> = new LazyValue(
    async () => {
      await state.login({
        orgName,
        apiKey,
        appUrl,
        fetch,
        forceLogin,
      });

      if (datasetId !== undefined) {
        const objectInfo = datasetObjectInfoSchema.array().parse(
          await state.appConn().post_json("api/self/get_object_info", {
            object_type: "dataset",
            object_ids: [datasetId],
          }),
        );
        if (objectInfo.length === 0) {
          throw new Error(`Dataset with ID ${datasetId} not found`);
        }
        if (objectInfo.length !== 1) {
          throw new Error(
            `Expected exactly one dataset with ID ${datasetId}, but found ${objectInfo.length}`,
          );
        }

        const datasetInfo = objectInfo[0];
        return {
          project: {
            id: datasetInfo.parent_cols.project.id,
            name: datasetInfo.parent_cols.project.name,
            fullInfo: datasetInfo.parent_cols.project,
          },
          dataset: {
            id: datasetInfo.object_id,
            name: datasetInfo.object_name,
            fullInfo: datasetInfo,
          },
        };
      }

      const args: Record<string, unknown> = {
        org_id: state.orgId,
        project_name: project,
        project_id: projectId,
        dataset_name: dataset,
        description,
        metadata,
      };
      const response = await state
        .appConn()
        .post_json("api/dataset/register", args);

      return {
        project: {
          id: response.project.id,
          name: response.project.name,
          fullInfo: response.project,
        },
        dataset: {
          id: response.dataset.id,
          name: response.dataset.name,
          fullInfo: response.dataset,
        },
      };
    },
  );

  const resolvedVersion =
    normalizedVersion !== undefined
      ? normalizedVersion
      : normalizedSnapshotName !== undefined
        ? new LazyValue(async () => {
            return await resolveDatasetSnapshotNameForMetadata({
              state,
              lazyMetadata,
              snapshotName: normalizedSnapshotName,
            });
          })
        : normalizedEnvironment !== undefined
          ? new LazyValue(async () => {
              return await resolveDatasetEnvironmentForMetadata({
                state,
                lazyMetadata,
                environment: normalizedEnvironment,
              });
            })
          : undefined;

  const datasetObject = new Dataset(
    stateArg ?? _internalGetGlobalState(),
    lazyMetadata,
    typeof resolvedVersion === "string" ? resolvedVersion : undefined,
    internalBtql,
    resolvedVersion instanceof LazyValue ||
      normalizedEnvironment !== undefined ||
      normalizedSnapshotName !== undefined
      ? {
          ...(resolvedVersion instanceof LazyValue
            ? {
                lazyPinnedVersion: resolvedVersion,
              }
            : {}),
          ...(normalizedEnvironment !== undefined
            ? {
                pinnedEnvironment: normalizedEnvironment,
              }
            : {}),
          ...(normalizedSnapshotName !== undefined
            ? {
                pinnedSnapshotName: normalizedSnapshotName,
              }
            : {}),
        }
      : undefined,
  );

  return datasetObject;
}

/**
 * A dataset is a collection of records, such as model inputs and expected outputs, which represent
 * data you can use to evaluate and fine-tune models. You can log production data to datasets,
 * curate them with interesting examples, edit/delete records, and run evaluations against them.
 *
 * You should not create `Dataset` objects directly. Instead, use the `braintrust.initDataset()` method.
 */
export class Dataset extends ObjectFetcher<DatasetRecord> {
  private readonly lazyMetadata: LazyValue<ProjectDatasetMetadata>;
  private readonly __braintrust_dataset_marker = true;
  private newRecords = 0;
  private lazyPinnedVersion?: LazyValue<string | undefined>;
  private pinnedEnvironment?: string;
  private pinnedSnapshotName?: string;

  constructor(
    private state: BraintrustState,
    lazyMetadata: LazyValue<ProjectDatasetMetadata>,
    pinnedVersion?: string,
    _internal_btql?: Record<string, unknown>,
    pinState?: DatasetPinState,
  ) {
    super(
      "dataset",
      pinnedVersion,
      (r: AnyDatasetRecord) =>
        ensureNewDatasetRecord(
          enrichAttachments(r, this.state),
        ) as WithTransactionId<DatasetRecord>,
      _internal_btql,
    );
    void this.__braintrust_dataset_marker;
    this.lazyMetadata = lazyMetadata;
    this.lazyPinnedVersion = pinState?.lazyPinnedVersion;
    this.pinnedEnvironment = pinState?.pinnedEnvironment;
    this.pinnedSnapshotName = pinState?.pinnedSnapshotName;
  }

  public get id(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).dataset.id;
    })();
  }

  public get name(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).dataset.name;
    })();
  }

  public get project(): Promise<ObjectMetadata> {
    return (async () => {
      return (await this.lazyMetadata.get()).project;
    })();
  }

  public get loggingState(): BraintrustState {
    return this.state;
  }

  public async toEvalData(): Promise<{
    dataset_id: string;
    dataset_version?: string;
    dataset_environment?: string;
    dataset_snapshot_name?: string;
    _internal_btql?: Record<string, unknown>;
  }> {
    await this.getState();
    const metadata = await this.lazyMetadata.get();
    const pinnedVersion = this.getPinnedVersion();
    const internalBtql = this.getInternalBtql();

    return {
      dataset_id: metadata.dataset.id,
      ...(this.pinnedEnvironment !== undefined
        ? {
            dataset_environment: this.pinnedEnvironment,
          }
        : {}),
      ...(this.pinnedEnvironment === undefined &&
      this.pinnedSnapshotName !== undefined
        ? {
            dataset_snapshot_name: this.pinnedSnapshotName,
          }
        : {}),
      ...(this.pinnedEnvironment === undefined &&
      this.pinnedSnapshotName === undefined &&
      pinnedVersion !== undefined
        ? {
            dataset_version: pinnedVersion,
          }
        : {}),
      ...(internalBtql !== undefined ? { _internal_btql: internalBtql } : {}),
    };
  }

  protected async getState(): Promise<BraintrustState> {
    // Ensure the login state is populated by awaiting lazyMetadata.
    await this.lazyMetadata.get();
    if (
      this.lazyPinnedVersion !== undefined &&
      this.getPinnedVersion() === undefined
    ) {
      this.setPinnedVersion(await this.lazyPinnedVersion.get());
    }
    return this.state;
  }

  public override async version(options?: {
    batchSize?: number;
  }): Promise<string | undefined> {
    const pinnedVersion = this.getPinnedVersion();
    if (pinnedVersion !== undefined) {
      return pinnedVersion;
    }
    await this.getState();
    return await super.version(options);
  }

  private validateEvent({
    metadata,
    tags,
  }: {
    metadata?: Record<string, unknown>;
    tags?: string[];
  }) {
    if (metadata !== undefined) {
      for (const key of Object.keys(metadata)) {
        if (typeof key !== "string") {
          throw new Error("metadata keys must be strings");
        }
      }
    }

    if (tags) {
      validateTags(tags);
    }
  }

  private createArgs({
    id,
    input,
    expected,
    metadata,
    tags,
    origin,
    isMerge,
  }: {
    id: string;
    input?: unknown;
    expected?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
    origin?: ObjectReference;
    isMerge?: boolean;
  }): LazyValue<BackgroundLogEvent> {
    return new LazyValue(async () => {
      const dataset_id = await this.id;
      const args: BackgroundLogEvent = {
        id,
        input,
        expected,
        tags,
        dataset_id,
        created: !isMerge ? new Date().toISOString() : undefined, //if we're merging/updating an event we will not add this ts
        metadata,
        origin,
        ...(!!isMerge
          ? {
              [IS_MERGE_FIELD]: true,
            }
          : {}),
      };

      return args;
    });
  }

  /**
   * Insert a single record to the dataset. The record will be batched and uploaded behind the scenes. If you pass in an `id`,
   * and a record with that `id` already exists, it will be overwritten (upsert).
   *
   * @param event The event to log.
   * @param event.input The argument that uniquely define an input case (an arbitrary, JSON serializable object).
   * @param event.expected The output of your application, including post-processing (an arbitrary, JSON serializable object).
   * @param event.tags (Optional) a list of strings that you can use to filter and group records later.
   * @param event.metadata (Optional) a dictionary with additional data about the test example, model outputs, or just
   * about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the
   * `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any
   * JSON-serializable type, but its keys must be strings.
   * @param event.origin (Optional) a reference to the source object this dataset record was derived from.
   * @param event.id (Optional) a unique identifier for the event. If you don't provide one, Braintrust will generate one for you.
   * @returns The `id` of the logged record.
   */
  public insert({
    input,
    expected,
    metadata,
    tags,
    id,
    origin,
  }: {
    readonly input?: unknown;
    readonly expected?: unknown;
    readonly tags?: string[];
    readonly metadata?: Record<string, unknown>;
    readonly id?: string;
    readonly origin?: ObjectReference;
  }): string {
    this.validateEvent({ metadata, tags });

    const rowId = id || uuidv4();
    const args = this.createArgs(
      deepCopyEvent({
        id: rowId,
        input,
        expected,
        metadata,
        tags,
        origin,
        isMerge: false,
      }),
    );

    this.state.bgLogger().log([args]);
    this.newRecords++;
    return rowId;
  }

  /**
   * Update fields of a single record in the dataset. The updated fields will be batched and uploaded behind the scenes.
   * You must pass in an `id` of the record to update. Only the fields provided will be updated; other fields will remain unchanged.
   *
   * @param event The fields to update in the record.
   * @param event.id The unique identifier of the record to update.
   * @param event.input (Optional) The new input value for the record (an arbitrary, JSON serializable object).
   * @param event.expected (Optional) The new expected output value for the record (an arbitrary, JSON serializable object).
   * @param event.tags (Optional) A list of strings to update the tags of the record.
   * @param event.metadata (Optional) A dictionary to update the metadata of the record. The values in `metadata` can be any
   * JSON-serializable type, but its keys must be strings.
   * @returns The `id` of the updated record.
   */
  public update({
    input,
    expected,
    metadata,
    tags,
    id,
  }: {
    readonly id: string;
    readonly input?: unknown;
    readonly expected?: unknown;
    readonly tags?: string[];
    readonly metadata?: Record<string, unknown>;
  }): string {
    this.validateEvent({ metadata, tags });

    const args = this.createArgs(
      deepCopyEvent({
        id,
        input,
        expected,
        metadata,
        tags,
        isMerge: true,
      }),
    );

    this.state.bgLogger().log([args]);
    return id;
  }

  public delete(id: string): string {
    const args = new LazyValue(async () => ({
      id,
      dataset_id: await this.id,
      created: new Date().toISOString(),
      _object_delete: true,
    }));

    this.state.bgLogger().log([args]);
    return id;
  }

  public async createSnapshot({
    name,
    description,
    update,
  }: {
    readonly name: string;
    readonly description?: string;
    readonly update?: boolean;
  }): Promise<DatasetSnapshot> {
    await this.flush();
    const state = await this.getState();
    const datasetId = await this.id;
    // Live-row versions omit deletions. After flushing, get a server transaction
    // boundary that includes every completed write, even if no live rows remain.
    // getState() above also resolves versions pinned by snapshot or environment.
    const currentVersion =
      this.getPinnedVersion() ??
      (await (await state.apiConn().get("xact-id")).text());
    const response = await state
      .appConn()
      .post_json("api/dataset_snapshot/register", {
        dataset_id: datasetId,
        dataset_snapshot_name: name,
        description,
        xact_id: currentVersion,
        update,
      });
    return datasetSnapshotRegisterResponseSchema.parse(response)
      .dataset_snapshot;
  }

  public async listSnapshots(): Promise<DatasetSnapshot[]> {
    const state = await this.getState();
    return await getDatasetSnapshots({
      state,
      datasetId: await this.id,
    });
  }

  public async getSnapshot(
    lookup: DatasetSnapshotLookup,
  ): Promise<DatasetSnapshot | undefined> {
    const state = await this.getState();
    const datasetId = await this.id;
    return await getDatasetSnapshot({
      state,
      datasetId,
      ...lookup,
    });
  }

  public async updateSnapshot(
    snapshotId: string,
    {
      name,
      description,
    }: {
      readonly name?: string;
      readonly description?: string | null;
    },
  ): Promise<DatasetSnapshot> {
    const state = await this.getState();
    return datasetSnapshotSchema.parse(
      await state.appConn().post_json("api/dataset_snapshot/patch_id", {
        id: snapshotId,
        name,
        description,
      }),
    );
  }

  public async deleteSnapshot(snapshotId: string): Promise<DatasetSnapshot> {
    const state = await this.getState();
    return datasetSnapshotSchema.parse(
      await state.appConn().post_json("api/dataset_snapshot/delete_id", {
        id: snapshotId,
      }),
    );
  }

  public async restorePreview({
    version,
  }: {
    readonly version: string;
  }): Promise<DatasetRestorePreviewResult> {
    await this.flush();
    const state = await this.getState();
    const datasetId = await this.id;
    return datasetRestorePreviewResultSchema.parse(
      await state
        .apiConn()
        .post_json(`v1/dataset/${datasetId}/restore/preview`, {
          version,
        }),
    );
  }

  public async restore({
    version,
  }: {
    readonly version: string;
  }): Promise<DatasetRestoreResult> {
    await this.flush();
    const state = await this.getState();
    const datasetId = await this.id;
    return datasetRestoreResultSchema.parse(
      await state.apiConn().post_json(`v1/dataset/${datasetId}/restore`, {
        version,
      }),
    );
  }

  /**
   * Summarize the dataset, including high level metrics about its size and other metadata.
   * @param summarizeData Whether to summarize the data. If false, only the metadata will be returned.
   * @returns `DatasetSummary`
   * @returns A summary of the dataset.
   */
  public async summarize(
    options: { readonly summarizeData?: boolean } = {},
  ): Promise<DatasetSummary> {
    const { summarizeData = true } = options || {};

    await this.flush();
    const state = await this.getState();
    const projectUrl = `${state.appPublicUrl}/app/${encodeURIComponent(
      state.orgName!,
    )}/p/${encodeURIComponent((await this.project).name)}`;
    const datasetUrl = `${projectUrl}/datasets/${encodeURIComponent(
      await this.name,
    )}`;

    let dataSummary: DataSummary | undefined;
    if (summarizeData) {
      const rawDataSummary = z
        .object({
          total_records: z.number(),
        })
        .parse(
          await state.apiConn().get_json(
            "dataset-summary",
            {
              dataset_id: await this.id,
            },
            3,
          ),
        );
      dataSummary = {
        newRecords: this.newRecords,
        totalRecords: rawDataSummary.total_records,
      };
    }

    return {
      projectName: (await this.project).name,
      datasetName: await this.name,
      projectUrl,
      datasetUrl,
      dataSummary,
    };
  }

  /**
   * Flush any pending rows to the server.
   */
  async flush(): Promise<void> {
    return await this.state.bgLogger().flush();
  }

  public static isDataset(data: unknown): data is Dataset {
    return (
      typeof data === "object" &&
      data !== null &&
      "__braintrust_dataset_marker" in data
    );
  }
}

export type AnyDataset = Dataset;

/**
 * Summary of a dataset's data.
 *
 * @property totalRecords Total records in the dataset.
 */
export interface DataSummary {
  /**
   * New or updated records added in this session.
   */
  newRecords: number;
  /**
   * Total records in the dataset.
   */
  totalRecords: number;
}

/**
 * Summary of a dataset's scores and metadata.
 *
 * @property projectName Name of the project that the dataset belongs to.
 * @property datasetName Name of the dataset.
 * @property projectUrl URL to the project's page in the Braintrust app.
 * @property datasetUrl URL to the experiment's page in the Braintrust app.
 * @property dataSummary Summary of the dataset's data.
 */
export interface DatasetSummary {
  projectName: string;
  datasetName: string;
  projectUrl: string;
  datasetUrl: string;
  dataSummary: DataSummary | undefined;
}
