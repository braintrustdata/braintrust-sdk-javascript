import { z } from "zod/v3";
import {
  AsyncScoringControlType as AsyncScoringControl,
  ObjectReference as objectReferenceSchema,
} from "./generated_types";
import {
  Source,
  ASYNC_SCORING_CONTROL_FIELD,
  AUDIT_METADATA_FIELD,
  AUDIT_SOURCE_FIELD,
  IS_MERGE_FIELD,
  MERGE_PATHS_FIELD,
  SKIP_ASYNC_SCORING_FIELD,
} from "./db_fields";

export type IdField = { id: string };
export type InputField = { input: unknown };
export type OtherExperimentLogFields = {
  output: unknown;
  expected: unknown;
  error: unknown;
  tags: string[];
  scores: Record<string, number | null>;
  classifications?: Record<string, { id: string; label: string }[]>;
  metadata: Record<string, unknown>;
  metrics: Record<string, unknown>;
  datasetRecordId: string;
  origin: z.infer<typeof objectReferenceSchema>;
  span_attributes: Record<string, unknown>;
  [ASYNC_SCORING_CONTROL_FIELD]: AsyncScoringControl;
  [MERGE_PATHS_FIELD]: string[][];
  [SKIP_ASYNC_SCORING_FIELD]: boolean;
};

export type ExperimentLogPartialArgs = Partial<OtherExperimentLogFields> &
  Partial<InputField>;

export type ExperimentLogFullArgs = Partial<
  Omit<OtherExperimentLogFields, "output" | "scores">
> &
  Required<Pick<OtherExperimentLogFields, "output" | "scores">> &
  Partial<InputField> &
  Partial<IdField>;

export type LogFeedbackFullArgs = IdField &
  Partial<
    Omit<OtherExperimentLogFields, "output" | "metrics" | "datasetRecordId"> & {
      comment: string;
      source: Source;
    }
  >;

export interface ParentExperimentIds {
  experiment_id: string;
}

export interface ParentProjectLogIds {
  project_id: string;
  log_id: "g";
}

export interface ParentPlaygroundLogIds {
  prompt_session_id: string;
  log_id: "x";
}

export type LogCommentFullArgs = IdField & {
  created: string;
  origin: {
    id: string;
  };
  comment: {
    text: string;
  };
  [AUDIT_SOURCE_FIELD]: Source;
  [AUDIT_METADATA_FIELD]?: Record<string, unknown>;
} & (ParentExperimentIds | ParentProjectLogIds);

export type SanitizedExperimentLogPartialArgs =
  Partial<OtherExperimentLogFields> & Partial<InputField>;

export type ExperimentEvent = Partial<InputField> &
  Partial<OtherExperimentLogFields> & {
    id: string;
    span_id?: string;
    root_span_id?: string;
    experiment_id: string;
    [IS_MERGE_FIELD]: boolean;
  } & Partial<{
    created: string;
    span_parents: string[];
    span_attributes: Record<string, unknown>;
    context: Record<string, unknown>;
    [AUDIT_SOURCE_FIELD]: Source;
    [AUDIT_METADATA_FIELD]?: Record<string, unknown>;
  }>;

export type DatasetEvent = {
  input?: unknown;
  tags?: string[];
  metadata?: unknown;
  created?: string;
  id: string;
  dataset_id: string;
} & ({ expected?: unknown } | { output?: unknown });

export type LoggingEvent = Omit<ExperimentEvent, "experiment_id"> & {
  project_id: string;
  log_id: "g";
};

export type PlaygroundLogEvent = Omit<ExperimentEvent, "experiment_id"> & {
  prompt_session_id: string;
  log_id: "x";
};

export type CommentEvent = IdField & {
  created: string;
  origin: {
    id: string;
  };
  comment: {
    text: string;
  };
  [AUDIT_SOURCE_FIELD]: Source;
  [AUDIT_METADATA_FIELD]?: Record<string, unknown>;
} & (ParentExperimentIds | ParentProjectLogIds | ParentPlaygroundLogIds);

export type BackgroundLogEvent =
  | ExperimentEvent
  | DatasetEvent
  | LoggingEvent
  | PlaygroundLogEvent
  | CommentEvent;

export const DEFAULT_IS_LEGACY_DATASET = false;

interface LegacyDatasetRecord {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any;
}

interface NewDatasetRecord {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expected: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any;
}

export type DatasetRecord<
  IsLegacyDataset extends boolean = typeof DEFAULT_IS_LEGACY_DATASET,
> = IsLegacyDataset extends true ? LegacyDatasetRecord : NewDatasetRecord;

export type AnyDatasetRecord = DatasetRecord<boolean>;

export function ensureDatasetRecord<
  IsLegacyDataset extends boolean = typeof DEFAULT_IS_LEGACY_DATASET,
>(
  r: AnyDatasetRecord,
  legacy: IsLegacyDataset,
): DatasetRecord<IsLegacyDataset> {
  if (legacy) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return ensureLegacyDatasetRecord(r) as DatasetRecord<IsLegacyDataset>;
  } else {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return ensureNewDatasetRecord(r) as DatasetRecord<IsLegacyDataset>;
  }
}

export function ensureLegacyDatasetRecord(
  r: AnyDatasetRecord,
): DatasetRecord<true> {
  if ("output" in r) {
    return r;
  }
  const row = {
    ...r,
    output: r.expected,
  };
  delete row.expected;
  return row;
}

export function ensureNewDatasetRecord(
  r: AnyDatasetRecord,
): DatasetRecord<false> {
  if ("expected" in r) {
    return r;
  }
  const row = {
    ...r,
    tags: null,
    expected: r.output,
  };
  delete row.output;
  return row;
}
