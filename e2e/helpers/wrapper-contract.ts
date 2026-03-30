import type {
  CapturedLogEvent,
  CapturedLogPayload,
  CapturedLogRow,
} from "./mock-braintrust-server";
import type { Json } from "./normalize";

function pickMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): Json {
  if (!metadata) {
    return null;
  }

  const picked = Object.fromEntries(
    keys.flatMap((key) =>
      key in metadata ? [[key, metadata[key] as Json]] : [],
    ),
  );

  return Object.keys(picked).length > 0 ? (picked as Json) : null;
}

function stageRank(row: CapturedLogRow): number {
  const metrics =
    typeof row.metrics === "object" &&
    row.metrics !== null &&
    !Array.isArray(row.metrics)
      ? (row.metrics as Record<string, unknown>)
      : undefined;
  const metricKeys = Object.keys(metrics ?? {});
  const hasOutput = row.output !== undefined;
  const hasNonEndMetrics = metricKeys.some((key) => key !== "end");

  if (row._is_merge !== true) {
    return 0;
  }
  if (hasNonEndMetrics && !hasOutput) {
    return 1;
  }
  if (hasOutput) {
    return 2;
  }
  return 3;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTestRunId(value: unknown, testRunId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasTestRunId(entry, testRunId));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.testRunId === testRunId) {
    return true;
  }

  return Object.values(value).some((entry) => hasTestRunId(entry, testRunId));
}

function splitTerminalMergeRow(row: CapturedLogRow): CapturedLogRow[] {
  const metrics =
    typeof row.metrics === "object" &&
    row.metrics !== null &&
    !Array.isArray(row.metrics)
      ? ({ ...(row.metrics as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : undefined;

  if (row._is_merge !== true) {
    return [row];
  }

  const { end, ...restMetrics } = metrics ?? {};
  const hasRestMetrics = Object.keys(restMetrics).length > 0;
  const hasEnd = typeof end === "number";
  const hasPayloadContent =
    row.input !== undefined ||
    row.output !== undefined ||
    row.metadata !== undefined ||
    row.expected !== undefined ||
    row.scores !== undefined;

  const stageCount =
    Number(hasRestMetrics) + Number(hasPayloadContent) + Number(hasEnd);
  if (stageCount <= 1) {
    return [row];
  }

  const rows: CapturedLogRow[] = [];

  if (hasRestMetrics) {
    const metricsRow: CapturedLogRow = {
      ...row,
      metrics: restMetrics,
    };
    delete metricsRow.input;
    delete metricsRow.output;
    delete metricsRow.metadata;
    delete metricsRow.expected;
    delete metricsRow.scores;
    rows.push(metricsRow);
  }

  if (hasPayloadContent) {
    const payloadRow: CapturedLogRow = { ...row };
    delete payloadRow.metrics;
    rows.push(payloadRow);
  }

  if (hasEnd) {
    const endRow: CapturedLogRow = { ...row, metrics: { end } };
    delete endRow.input;
    delete endRow.output;
    delete endRow.metadata;
    delete endRow.expected;
    delete endRow.scores;
    rows.push(endRow);
  }

  return rows;
}

function payloadRowIdentity(row: CapturedLogRow): string {
  return JSON.stringify(
    [
      "org_id",
      "project_id",
      "experiment_id",
      "dataset_id",
      "prompt_session_id",
      "log_id",
      "id",
    ].map((key) => row[key]),
  );
}

function mergeValue(base: unknown, incoming: unknown): unknown {
  if (isRecord(base) && isRecord(incoming)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }

  return incoming;
}

function mergePayloadRow(
  existing: CapturedLogRow | undefined,
  incoming: CapturedLogRow,
): CapturedLogRow {
  if (!existing || !incoming._is_merge) {
    return structuredClone(incoming);
  }

  const preserveNoMerge = !existing._is_merge;
  const merged = mergeValue(existing, incoming) as CapturedLogRow;
  if (preserveNoMerge) {
    delete merged._is_merge;
  }
  return structuredClone(merged);
}

function sortPayloadRows(rows: CapturedLogRow[]): CapturedLogRow[] {
  const spanOrder = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.span_id === "string" && !spanOrder.has(row.span_id)) {
      spanOrder.set(row.span_id, spanOrder.size);
    }
  }

  return [...rows].sort((left, right) => {
    const leftOrder =
      typeof left.span_id === "string"
        ? (spanOrder.get(left.span_id) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
    const rightOrder =
      typeof right.span_id === "string"
        ? (spanOrder.get(right.span_id) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return stageRank(left) - stageRank(right);
  });
}

export function summarizeWrapperContract(
  event: CapturedLogEvent,
  metadataKeys: string[] = [],
): Json {
  return {
    has_input: event.input !== undefined && event.input !== null,
    has_output: event.output !== undefined && event.output !== null,
    metadata: pickMetadata(
      event.row.metadata as Record<string, unknown>,
      metadataKeys,
    ),
    metric_keys: Object.keys(event.metrics ?? {})
      .filter((key) => key !== "start" && key !== "end")
      .sort(),
    name: event.span.name ?? null,
    root_span_id: event.span.rootId ?? null,
    span_id: event.span.id ?? null,
    span_parents: event.span.parentIds,
    type: event.span.type ?? null,
  } satisfies Json;
}

export function payloadRowsForRootSpan(
  payloads: CapturedLogPayload[],
  rootSpanId: string | undefined,
): CapturedLogRow[] {
  if (!rootSpanId) {
    return [];
  }

  const rows = payloads
    .flatMap((payload) => payload.rows)
    .filter((row) => row.root_span_id === rootSpanId)
    .flatMap((row) => splitTerminalMergeRow(row));

  return sortPayloadRows(rows);
}

export function payloadRowsForTestRunId(
  payloads: CapturedLogPayload[],
  testRunId: string,
): CapturedLogRow[] {
  const mergedRows = new Map<string, CapturedLogRow>();
  for (const row of payloads.flatMap((payload) => payload.rows)) {
    const key = payloadRowIdentity(row);
    mergedRows.set(key, mergePayloadRow(mergedRows.get(key), row));
  }

  const rows = [...mergedRows.values()]
    .filter((row) => hasTestRunId(row, testRunId))
    .flatMap((row) => splitTerminalMergeRow(row));

  return sortPayloadRows(rows);
}
