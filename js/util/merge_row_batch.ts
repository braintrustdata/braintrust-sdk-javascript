import { IS_MERGE_FIELD, MERGE_PATHS_FIELD } from "./db_fields";
import { mergeDictsWithPaths } from "./object_util";

function generateMergedRowKey(row: Record<string, unknown>) {
  return JSON.stringify(
    [
      "org_id",
      "project_id",
      "experiment_id",
      "dataset_id",
      "prompt_session_id",
      "log_id",
      "id",
    ].map((k) => row[k]),
  );
}

// These fields will be retained as-is when merging rows.
const MERGE_ROW_SKIP_FIELDS = [
  "created",
  "span_id",
  "root_span_id",
  "span_parents",
  "_parent_id",
] as const;
type MergeRowSkipField = (typeof MERGE_ROW_SKIP_FIELDS)[number];
type MergeRowSkipFieldObj = { [K in MergeRowSkipField]?: unknown };

function extractValidMergePaths(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (path): path is string[] =>
      Array.isArray(path) && path.every((part) => typeof part === "string"),
  );
}

function removeRedundantMergePaths(paths: string[][]): string[][] {
  return paths.filter(
    (path, index) =>
      !paths.some((candidate, candidateIndex) => {
        if (candidateIndex === index || candidate.length > path.length) {
          return false;
        }
        const candidateIsPrefix = candidate.every(
          (part, partIndex) => part === path[partIndex],
        );
        return (
          candidateIsPrefix &&
          (candidate.length < path.length || candidateIndex < index)
        );
      }),
  );
}

function popMergeRowSkipFields<T extends MergeRowSkipFieldObj>(
  row: T,
): MergeRowSkipFieldObj {
  const popped: MergeRowSkipFieldObj = {};
  for (const field of MERGE_ROW_SKIP_FIELDS) {
    if (field in row) {
      popped[field] = row[field];
      delete row[field];
    }
  }
  return popped;
}

function restoreMergeRowSkipFields<T extends MergeRowSkipFieldObj>(
  row: T,
  skipFields: MergeRowSkipFieldObj,
) {
  for (const field of MERGE_ROW_SKIP_FIELDS) {
    delete row[field];
    if (field in skipFields) {
      row[field] = skipFields[field];
    }
  }
}

export function mergeRowBatch<
  T extends {
    id: string;
    [IS_MERGE_FIELD]?: boolean | null;
    [MERGE_PATHS_FIELD]?: unknown;
  } & MergeRowSkipFieldObj,
>(rows: T[]): T[] {
  for (const row of rows) {
    if (row.id === undefined) {
      throw new Error(
        "Logged row is missing an id. This is an internal braintrust error. Please contact us at info@braintrust.dev for help",
      );
    }
  }

  const rowGroups: Map<string, T> = new Map();
  for (const row of rows) {
    const key = generateMergedRowKey(row);
    const existingRow = rowGroups.get(key);
    if (existingRow !== undefined && row[IS_MERGE_FIELD]) {
      const skipFields = popMergeRowSkipFields(existingRow);
      const preserveNoMerge = !existingRow[IS_MERGE_FIELD];
      const existingMergePaths = extractValidMergePaths(
        existingRow[MERGE_PATHS_FIELD],
      );
      const incomingMergePaths = extractValidMergePaths(row[MERGE_PATHS_FIELD]);
      const combinedMergePaths = removeRedundantMergePaths([
        ...existingMergePaths,
        ...incomingMergePaths,
      ]);
      mergeDictsWithPaths({
        mergeFrom: row,
        mergeInto: existingRow,
        mergePaths: incomingMergePaths,
      });
      if (combinedMergePaths.length > 0) {
        existingRow[MERGE_PATHS_FIELD] = combinedMergePaths;
      } else {
        delete existingRow[MERGE_PATHS_FIELD];
      }
      restoreMergeRowSkipFields(existingRow, skipFields);
      if (preserveNoMerge) {
        delete existingRow[IS_MERGE_FIELD];
      }
    } else {
      rowGroups.set(key, row);
    }
  }

  return [...rowGroups.values()];
}

export function batchItems<T>(args: {
  items: T[];
  batchMaxNumItems?: number;
  batchMaxNumBytes?: number;
  getByteSize: (item: T) => number;
}): T[][] {
  const { items } = args;
  const batchMaxNumItems = args.batchMaxNumItems ?? Number.POSITIVE_INFINITY;
  const batchMaxNumBytes = args.batchMaxNumBytes ?? Number.POSITIVE_INFINITY;
  const getByteSize = args.getByteSize;

  const output: T[][] = [];
  let batch: T[] = [];
  let batchLen = 0;

  function addToBatch(item: T) {
    batch.push(item);
    batchLen += getByteSize(item);
  }

  function flushBatch() {
    output.push(batch);
    batch = [];
    batchLen = 0;
  }

  for (const item of items) {
    const itemSize = getByteSize(item);
    if (
      batch.length > 0 &&
      !(
        itemSize + batchLen < batchMaxNumBytes &&
        batch.length < batchMaxNumItems
      )
    ) {
      flushBatch();
    }
    addToBatch(item);
  }
  if (batch.length > 0) {
    flushBatch();
  }

  return output;
}
