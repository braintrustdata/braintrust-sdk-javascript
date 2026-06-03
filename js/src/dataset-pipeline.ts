import type { Trace } from "./trace";

type DatasetPipelineRow = {
  input?: unknown;
  expected?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  id?: string;
};

type DatasetPipelineTransformResult =
  | DatasetPipelineRow
  | DatasetPipelineRow[]
  | null
  | undefined;

type DatasetPipelineDefinition<Scope extends "span" | "trace"> = {
  /** The name of the dataset pipeline as it will show up in Braintrust */
  name?: string;
  /** Information about what spans/traces should be passed into the dataset pipeline. */
  source: {
    /** What project to take spans/traces from. Has precedence over `projectName`. */
    projectId?: string;
    /** What project to take spans/traces from. */
    projectName?: string;
    /** What organization to take spans/traces from. */
    orgName?: string;
    /** An optional BTQL filter to filter spans by. Not providing this filter means all spans/traces are eligible for the pipeline. */
    filter?: string;
    /**
     * Whether to pass exclusively spans or entire traces to the pipeline. Affects the transform input arguments.
     *
     * Defaults to: `"span"`
     */
    scope?: Scope;
  };
  /**
   * A transformation function that either receives a span or a trace, depending on what scope was defined in the `source.scope` option.
   *
   * Can return one or more new rows for the target dataset, or `null`/`undefined` if no new row should be inserted.
   */
  transform: (
    transformInput: Scope extends "span"
      ? {
          id: string;
          input: unknown;
          output: unknown;
          expected: unknown;
          metadata?: Record<string, unknown>;
          trace: Trace;
        }
      : { trace: Trace },
  ) => DatasetPipelineTransformResult | Promise<DatasetPipelineTransformResult>;
  /** Information about the target dataset */
  target: {
    /** Id of the project where the dataset currently lives or should be created or updated. */
    projectId?: string;
    /** Name of the project where the dataset currently lives or should be created or updated. */
    projectName?: string;
    /** Organization name of the project where the dataset currently lives or should be created or updated. */
    orgName?: string;
    /** Name of the dataset. Either the current name or new name if the dataset is created or updated. */
    datasetName: string;
    /** Description of the dataset when the dataset is created or updated. */
    description?: string;
    /** Metadata of the dataset when the dataset is created or updated. */
    metadata?: Record<string, unknown>;
  };
};

/**
 * This is the interface for pipelines that is exposed to `bt`
 */
type DatasetPipelineBtDefinition = {
  name?: string;
  source: {
    projectId?: string;
    projectName?: string;
    orgName?: string;
    filter?: string;
    scope: "span" | "trace";
  };
  transform: (
    transformInput:
      | {
          id: string;
          input: unknown;
          output: unknown;
          expected: unknown;
          metadata?: Record<string, unknown>;
          trace: Trace;
        }
      | { trace: Trace },
  ) => DatasetPipelineTransformResult | Promise<DatasetPipelineTransformResult>;
  target: {
    projectId?: string;
    projectName?: string;
    orgName?: string;
    datasetName: string;
    description?: string;
    metadata?: Record<string, unknown>;
  };
};

declare global {
  // DO NOT CHANGE THE NAME OR INTERFACE OF THIS GLOBAL IN A NON-BACKWARDS COMPATIBLE WAY: `bt` CLI depends on it
  var __braintrust_dataset_pipelines: DatasetPipelineBtDefinition[] | undefined;
}

/**
 * Creates a runnable dataset pipeline.
 *
 * Dataset pipelines can be used to take trace data stored in Braintrust, filter and transform it, and directly feed it back into a Braintrust dataset.
 *
 * You can run a dataset pipeline with the `bt` CLI using `bt datasets pipeline run some-file-path.ts --limit 100`.
 * The limit option controls how many spans/traces (depending on the `definition.source.scope` option) are discovered for the pipeline.
 *
 * @experimental - The API for this function is not yet stabilized and may change or be removed across non-major versions. Functionality is not guaranteed.
 */
export function DatasetPipeline<Scope extends "span" | "trace">(
  definition: DatasetPipelineDefinition<Scope>,
): void {
  if (!globalThis.__braintrust_dataset_pipelines) {
    globalThis.__braintrust_dataset_pipelines = [];
  }

  const storedDefinition: DatasetPipelineBtDefinition = {
    name: definition.name,
    source: {
      projectId: definition.source.projectId,
      projectName: definition.source.projectName,
      orgName: definition.source.orgName,
      filter: definition.source.filter,
      scope: definition.source.scope ?? "span",
    },
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    transform: definition.transform as any,
    target: {
      projectId: definition.target.projectId,
      projectName: definition.target.projectName,
      orgName: definition.target.orgName,
      datasetName: definition.target.datasetName,
      description: definition.target.description,
      metadata: definition.target.metadata,
    },
  };

  globalThis.__braintrust_dataset_pipelines.push(storedDefinition);
}
