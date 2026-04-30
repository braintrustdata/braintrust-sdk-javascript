import type { ObjectReferenceType as ObjectReference } from "./generated_types";
import type { Dataset, FullInitDatasetOptions } from "./logger";
import type { Trace } from "./trace";

export type DatasetPipelineScope = "span" | "trace";

export type DatasetPipelineSource = {
  projectId?: string;
  projectName?: string;
  orgName?: string;
  filter?: string;
  scope?: DatasetPipelineScope;
  limit?: number;
};

type DatasetPipelineInitDatasetOptions = FullInitDatasetOptions<false>;

export type DatasetPipelineOrigin = ObjectReference;

export type DatasetPipelineTarget = {
  projectId?: DatasetPipelineInitDatasetOptions["projectId"];
  projectName?: DatasetPipelineInitDatasetOptions["project"];
  orgName?: DatasetPipelineInitDatasetOptions["orgName"];
  datasetName: NonNullable<DatasetPipelineInitDatasetOptions["dataset"]>;
  description?: DatasetPipelineInitDatasetOptions["description"];
  metadata?: DatasetPipelineInitDatasetOptions["metadata"];
};

export type DatasetPipelineRow = Parameters<Dataset["insert"]>[0];

export type DatasetPipelineCandidate = {
  trace: Trace;
  /**
   * The matching source span row id when the source scope is "span".
   */
  id?: string;
  /**
   * Default provenance for rows returned by transform. In span scope this
   * points at the matching source span row.
   */
  origin?: ObjectReference;
};

export type DatasetPipelineTransformContext = {
  pipeline: DatasetPipelineDefinition;
};

export type DatasetPipelineTransformResult =
  | DatasetPipelineRow
  | DatasetPipelineRow[]
  | null
  | undefined;

export type DatasetPipelineTransform = (
  candidate: DatasetPipelineCandidate,
  context: DatasetPipelineTransformContext,
) => DatasetPipelineTransformResult | Promise<DatasetPipelineTransformResult>;

export type DatasetPipelineDefinition = {
  name?: string;
  source: DatasetPipelineSource;
  transform: DatasetPipelineTransform;
  target: DatasetPipelineTarget;
};

const DATASET_PIPELINE_MARKER = "__braintrustDatasetPipeline";

declare global {
  // eslint-disable-next-line no-var
  var __braintrust_dataset_pipelines: DatasetPipelineDefinition[] | undefined;
}

function registry(): DatasetPipelineDefinition[] {
  if (!globalThis.__braintrust_dataset_pipelines) {
    globalThis.__braintrust_dataset_pipelines = [];
  }
  return globalThis.__braintrust_dataset_pipelines;
}

export function getRegisteredDatasetPipelines(): DatasetPipelineDefinition[] {
  return [...registry()];
}

export function isDatasetPipelineDefinition(
  value: unknown,
): value is DatasetPipelineDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    DATASET_PIPELINE_MARKER in value
  );
}

export function DatasetPipeline(
  definition: DatasetPipelineDefinition,
): DatasetPipelineDefinition {
  const registered = Object.assign(definition, {
    [DATASET_PIPELINE_MARKER]: true,
  });
  registry().push(registered);
  return registered;
}
