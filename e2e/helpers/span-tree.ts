import type { ExpectStatic } from "vitest";
import { matchFileSnapshot } from "./file-snapshot";
import type { CapturedLogEvent } from "./mock-braintrust-server";
import {
  normalizeForSnapshot,
  type Json,
  type NormalizeOptions,
} from "./normalize";

export type SpanTreeFields = Record<string, unknown>;

export type SpanTreeEntry = {
  event: CapturedLogEvent;
  fields?: SpanTreeFields;
  name?: string;
};

type NormalizedEntry = {
  children: NormalizedEntry[];
  event: CapturedLogEvent;
  fields: SpanTreeFields;
  firstSeen: number;
  id: string;
  name: string;
};

type SpanTreeJsonNode = {
  children: SpanTreeJsonNode[];
  name: string;
  type?: string;
} & Record<string, Json | SpanTreeJsonNode[] | string | undefined>;

type SpanTreeSnapshotOptions = {
  normalize?: NormalizeOptions;
  snapshotExpect?: ExpectStatic;
};

const FIELD_ORDER = [
  "span_attributes",
  "input",
  "output",
  "expected",
  "scores",
  "tags",
  "metadata",
  "metrics",
  "error",
];

const FIELD_LABELS = new Map([["span_attributes", "attributes"]]);
const OMITTED_SPAN_ATTRIBUTE_KEYS = new Set(["name", "type", "exec_counter"]);
const OMITTED_METRIC_KEYS = new Set(["start", "end"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonClone(value: unknown): Json | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Json;
}

function normalizeJson(
  value: unknown,
  options?: NormalizeOptions,
): Json | undefined {
  const cloned = jsonClone(value);
  return cloned === undefined
    ? undefined
    : normalizeForSnapshot(cloned, options);
}

function sortJsonKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonKeys(entry as Json));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonKeys(value[key] as Json)]),
    ) as Json;
  }

  return value;
}

function compactRecord(
  value: unknown,
  omittedKeys: Set<string> = new Set(),
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const compacted = Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => !omittedKeys.has(key) && entry !== undefined,
    ),
  );
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function stableMetrics(value: unknown): Record<string, unknown> | undefined {
  const metrics = compactRecord(value, OMITTED_METRIC_KEYS);
  if (!metrics) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(metrics).map(([key, entry]) => [
      key,
      typeof entry === "number" &&
      (key === "duration" ||
        key === "time_to_first_token" ||
        key.endsWith("_ms") ||
        key.includes("duration"))
        ? 0
        : entry,
    ]),
  );
}

export function spanTreeFields(event: CapturedLogEvent): SpanTreeFields {
  return {
    span_attributes: compactRecord(
      event.row.span_attributes,
      OMITTED_SPAN_ATTRIBUTE_KEYS,
    ),
    input: event.input,
    output: event.output,
    expected: event.expected,
    scores: event.scores,
    tags: event.row.tags,
    metadata: compactRecord(event.metadata),
    metrics: stableMetrics(event.metrics),
    error: event.row.error,
  };
}

function toSpanTreeEntry(
  input: CapturedLogEvent | SpanTreeEntry,
): SpanTreeEntry {
  return "event" in input ? input : { event: input };
}

function entryId(entry: SpanTreeEntry, index: number): string {
  return (
    entry.event.span.id ??
    (typeof entry.event.row.id === "string"
      ? `row:${entry.event.row.id}`
      : `index:${index}`)
  );
}

function displayName(entry: SpanTreeEntry): string {
  return entry.name ?? entry.event.span.name ?? "<unnamed>";
}

function sortedFieldKeys(fields: Record<string, Json>): string[] {
  return Object.keys(fields).sort((left, right) => {
    const leftOrder = FIELD_ORDER.indexOf(left);
    const rightOrder = FIELD_ORDER.indexOf(right);

    if (leftOrder !== -1 || rightOrder !== -1) {
      return (
        (leftOrder === -1 ? Number.MAX_SAFE_INTEGER : leftOrder) -
        (rightOrder === -1 ? Number.MAX_SAFE_INTEGER : rightOrder)
      );
    }

    return left.localeCompare(right);
  });
}

function fieldLabel(key: string): string {
  return FIELD_LABELS.get(key) ?? key;
}

function shouldRenderField(value: Json | undefined): value is Json {
  if (value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

function normalizeFields(
  fields: SpanTreeFields,
  options?: NormalizeOptions,
): Record<string, Json> {
  const normalized: Record<string, Json> = {};

  for (const [key, value] of Object.entries(fields)) {
    const normalizedValue = normalizeJson(value, options);
    if (shouldRenderField(normalizedValue)) {
      normalized[key] = sortJsonKeys(normalizedValue);
    }
  }

  return normalized;
}

function formatFieldBlock(
  label: string,
  value: Json,
  indent: string,
): string[] {
  const lines = JSON.stringify(value, null, 2).split("\n");
  return [
    `${indent}${label}: ${lines[0]}`,
    ...lines.slice(1).map((line) => `${indent}${line}`),
  ];
}

function buildEntries(
  inputs: readonly (CapturedLogEvent | SpanTreeEntry)[],
): NormalizedEntry[] {
  const entriesById = new Map<string, NormalizedEntry>();

  inputs.forEach((input, index) => {
    const entry = toSpanTreeEntry(input);
    const id = entryId(entry, index);
    const existing = entriesById.get(id);
    const normalized: NormalizedEntry = {
      children: existing?.children ?? [],
      event: entry.event,
      fields: entry.fields ?? spanTreeFields(entry.event),
      firstSeen: existing?.firstSeen ?? index,
      id,
      name: displayName(entry),
    };
    entriesById.set(id, normalized);
  });

  const entries = [...entriesById.values()];
  const roots: NormalizedEntry[] = [];

  for (const entry of entries) {
    const parentCandidates = entry.event.span.parentIds
      .map((parentId) => entriesById.get(parentId))
      .filter(
        (candidate): candidate is NormalizedEntry => candidate !== undefined,
      );
    const childStart =
      typeof entry.event.metrics?.start === "number"
        ? entry.event.metrics.start
        : undefined;
    const parent = parentCandidates.reduce<NormalizedEntry | undefined>(
      (best, candidate) => {
        const candidateStart =
          typeof candidate.event.metrics?.start === "number"
            ? candidate.event.metrics.start
            : undefined;
        if (
          childStart !== undefined &&
          candidateStart !== undefined &&
          candidateStart > childStart
        ) {
          return best;
        }
        if (!best) {
          return candidate;
        }

        const bestStart =
          typeof best.event.metrics?.start === "number"
            ? best.event.metrics.start
            : undefined;
        if (candidateStart !== undefined && bestStart === undefined) {
          return candidate;
        }
        if (
          candidateStart !== undefined &&
          bestStart !== undefined &&
          candidateStart !== bestStart
        ) {
          return candidateStart > bestStart ? candidate : best;
        }
        return candidate.firstSeen > best.firstSeen ? candidate : best;
      },
      undefined,
    );

    if (parent) {
      parent.children.push(entry);
    } else {
      roots.push(entry);
    }
  }

  const sortEntries = (items: NormalizedEntry[]) => {
    items.sort((left, right) => {
      const leftStart =
        typeof left.event.metrics?.start === "number"
          ? left.event.metrics.start
          : undefined;
      const rightStart =
        typeof right.event.metrics?.start === "number"
          ? right.event.metrics.start
          : undefined;

      if (
        leftStart !== undefined &&
        rightStart !== undefined &&
        leftStart !== rightStart
      ) {
        return leftStart - rightStart;
      }

      if (leftStart !== undefined && rightStart === undefined) {
        return -1;
      }
      if (leftStart === undefined && rightStart !== undefined) {
        return 1;
      }

      // Preserve capture order when timestamps are absent or identical. Log
      // batches can arrive out of order, so capture order alone is not a
      // stable chronology for spans with distinct start times.
      return left.firstSeen - right.firstSeen;
    });
    for (const item of items) {
      sortEntries(item.children);
    }
  };
  sortEntries(roots);

  return roots;
}

function renderEntry(
  entry: NormalizedEntry,
  prefix: string,
  isLast: boolean,
  options?: SpanTreeSnapshotOptions,
): string[] {
  const connector = isLast ? "└── " : "├── ";
  const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
  const type = entry.event.span.type ? ` [${entry.event.span.type}]` : "";
  const lines = [`${prefix}${connector}${entry.name}${type}`];
  const fields = normalizeFields(entry.fields, options?.normalize);

  for (const key of sortedFieldKeys(fields)) {
    lines.push(
      ...formatFieldBlock(fieldLabel(key), fields[key] as Json, childPrefix),
    );
  }

  entry.children.forEach((child, index) => {
    lines.push(
      ...renderEntry(
        child,
        childPrefix,
        index === entry.children.length - 1,
        options,
      ),
    );
  });

  return lines;
}

export function formatSpanTreeSnapshot(
  entries: readonly (CapturedLogEvent | SpanTreeEntry)[],
  options?: SpanTreeSnapshotOptions,
): string {
  const roots = buildEntries(entries);
  return [
    "span_tree:",
    ...roots.flatMap((entry, index) =>
      renderEntry(entry, "", index === roots.length - 1, options),
    ),
    "",
  ].join("\n");
}

function jsonEntry(
  entry: NormalizedEntry,
  options?: SpanTreeSnapshotOptions,
): SpanTreeJsonNode {
  const node: SpanTreeJsonNode = {
    name: entry.name,
    ...(entry.event.span.type ? { type: entry.event.span.type } : {}),
    children: [],
  };
  const fields = normalizeFields(entry.fields, options?.normalize);

  for (const key of sortedFieldKeys(fields)) {
    node[fieldLabel(key)] = fields[key] as Json;
  }

  node.children = entry.children.map((child) => jsonEntry(child, options));
  return node;
}

export function formatSpanTreeJsonSnapshot(
  entries: readonly (CapturedLogEvent | SpanTreeEntry)[],
  options?: SpanTreeSnapshotOptions,
): string {
  const roots = buildEntries(entries);
  return `${JSON.stringify(
    {
      span_tree: roots.map((entry) => jsonEntry(entry, options)),
    },
    null,
    2,
  )}\n`;
}

function txtSnapshotPath(jsonSnapshotPath: string): string {
  return jsonSnapshotPath.endsWith(".json")
    ? `${jsonSnapshotPath.slice(0, -".json".length)}.txt`
    : `${jsonSnapshotPath}.txt`;
}

export async function matchSpanTreeSnapshot(
  entries: readonly (CapturedLogEvent | SpanTreeEntry)[],
  jsonSnapshotPath: string,
  options?: SpanTreeSnapshotOptions,
): Promise<void> {
  await matchFileSnapshot(
    formatSpanTreeSnapshot(entries, options),
    txtSnapshotPath(jsonSnapshotPath),
    options?.snapshotExpect,
  );
  await matchFileSnapshot(
    formatSpanTreeJsonSnapshot(entries, options),
    jsonSnapshotPath,
    options?.snapshotExpect,
  );
}
