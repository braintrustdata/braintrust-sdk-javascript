import { BraintrustState, ObjectFetcher, WithTransactionId } from "./logger";
import { invoke } from "./functions/invoke";

interface TraceOptions {
  objectType: "experiment" | "project_logs" | "playground_logs";
  objectId: string;
  rootSpanId: string;
  ensureSpansFlushed?: () => Promise<void>;
  state: BraintrustState;
}

/** Inclusive span duration bounds, in seconds. */
export interface SpanDurationFilter {
  /** Minimum value of metrics.end - metrics.start. */
  min?: number;
  /** Maximum value of metrics.end - metrics.start. */
  max?: number;
}

/**
 * Filters supported by Trace.getSpans(). Different fields combine with AND.
 *
 * Empty name/spanType arrays match no spans. Empty metadata/duration objects
 * add no constraints. Omit a field to leave it unfiltered.
 */
export interface SpanFilters {
  /** Match spans whose span_attributes.type equals any of these. */
  spanType?: string[];
  /** Match spans whose span_attributes.name equals any of these. */
  name?: string[];
  /** Match spans based on whether they recorded an error. */
  hasError?: boolean;
  /**
   * Match metadata keys at any depth without type coercion. `null` matches a
   * null or missing path.
   */
  metadata?: Record<string, unknown>;
  /** Bound how long the span took. */
  duration?: SpanDurationFilter;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpanRecord = any;

type BtqlExpression = Record<string, unknown>;

const spanFilterFields = new Set([
  "spanType",
  "name",
  "hasError",
  "metadata",
  "duration",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type MetadataLeaf = [path: string[], value: unknown];

interface CompiledSpanFilters {
  filters: SpanFilters;
  metadataLeaves: MetadataLeaf[];
}

function validateMetadataValue(
  value: unknown,
  ancestors: WeakSet<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throw new Error("filters.metadata numbers must be finite");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("filters.metadata values must be JSON-serializable");
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new Error("filters.metadata values must be JSON-serializable");
  }
  if (ancestors.has(value)) {
    throw new Error("filters.metadata must not contain cycles");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      validateMetadataValue(value[index], ancestors);
    }
  } else {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("filters.metadata keys must be strings");
    }
    for (const nested of Object.values(value)) {
      validateMetadataValue(nested, ancestors);
    }
  }
  ancestors.delete(value);
}

function compileMetadataLeaves(
  metadata: Record<string, unknown>,
  path: string[] = [],
  ancestors = new WeakSet<object>(),
): MetadataLeaf[] {
  if (Object.getOwnPropertySymbols(metadata).length > 0) {
    throw new Error("filters.metadata keys must be strings");
  }
  if (ancestors.has(metadata)) {
    throw new Error("filters.metadata must not contain cycles");
  }
  ancestors.add(metadata);

  const leaves: MetadataLeaf[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    const childPath = [...path, key];
    if (isRecord(value)) {
      leaves.push(...compileMetadataLeaves(value, childPath, ancestors));
    } else {
      validateMetadataValue(value, ancestors);
      leaves.push([childPath, value]);
    }
  }

  ancestors.delete(metadata);
  return leaves;
}

function normalizeSpanFilters(
  filters: unknown,
  spanType?: string[],
): CompiledSpanFilters {
  if (filters != null && !isRecord(filters)) {
    throw new Error("filters must be an object");
  }

  const values: Record<string, unknown> = { ...(filters ?? {}) };
  if (spanType !== undefined) {
    if (
      !Array.isArray(spanType) ||
      !spanType.every((item: unknown) => typeof item === "string")
    ) {
      throw new Error("spanType must be an array of strings");
    }
    if (Object.hasOwn(values, "spanType")) {
      throw new Error(
        "spanType cannot be provided both directly and in filters",
      );
    }
    // Preserve the original API's spanType: [] meaning of no constraint.
    if (spanType.length > 0) {
      values.spanType = spanType;
    }
  }

  if (Object.keys(values).some((field) => !spanFilterFields.has(field))) {
    throw new Error("Unsupported span filter fields");
  }

  for (const field of ["spanType", "name"] as const) {
    if (Object.hasOwn(values, field)) {
      const items = values[field];
      if (
        !Array.isArray(items) ||
        !items.every((item: unknown) => typeof item === "string")
      ) {
        throw new Error(`filters.${field} must be an array of strings`);
      }
    }
  }

  if (
    Object.hasOwn(values, "hasError") &&
    typeof values.hasError !== "boolean"
  ) {
    throw new Error("filters.hasError must be a boolean");
  }

  let compiledMetadataLeaves: MetadataLeaf[] = [];
  if (Object.hasOwn(values, "metadata")) {
    if (!isRecord(values.metadata)) {
      throw new Error("filters.metadata must be an object");
    }
    compiledMetadataLeaves = compileMetadataLeaves(values.metadata);
  }

  if (Object.hasOwn(values, "duration")) {
    if (
      !isRecord(values.duration) ||
      Object.keys(values.duration).some(
        (bound) => bound !== "min" && bound !== "max",
      )
    ) {
      throw new Error("filters.duration must contain only min and/or max");
    }
    if (
      Object.values(values.duration).some(
        (bound) => typeof bound !== "number" || !Number.isFinite(bound),
      )
    ) {
      throw new Error("filters.duration bounds must be finite numbers");
    }
  }

  const normalized: SpanFilters = {};
  if (Array.isArray(values.spanType)) {
    normalized.spanType = values.spanType;
  }
  if (Array.isArray(values.name)) {
    normalized.name = values.name;
  }
  if (typeof values.hasError === "boolean") {
    normalized.hasError = values.hasError;
  }
  if (isRecord(values.metadata)) {
    normalized.metadata = values.metadata;
  }
  if (isRecord(values.duration)) {
    normalized.duration = {};
    if (typeof values.duration.min === "number") {
      normalized.duration.min = values.duration.min;
    }
    if (typeof values.duration.max === "number") {
      normalized.duration.max = values.duration.max;
    }
  }
  return { filters: normalized, metadataLeaves: compiledMetadataLeaves };
}

function metadataEqual(actual: unknown, expected: unknown): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => metadataEqual(actual[index], value))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      return false;
    }
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return (
      actualKeys.length === expectedKeys.length &&
      expectedKeys.every(
        (key) =>
          Object.hasOwn(actual, key) &&
          metadataEqual(actual[key], expected[key]),
      )
    );
  }
  return actual === expected;
}

function matchesSpanFilters(
  span: SpanData,
  compiledFilters: CompiledSpanFilters,
): boolean {
  const { filters, metadataLeaves } = compiledFilters;
  if (
    filters.spanType !== undefined &&
    !filters.spanType.includes(span.span_attributes?.type ?? "")
  ) {
    return false;
  }
  if (
    filters.name !== undefined &&
    !filters.name.includes(span.span_attributes?.name ?? "")
  ) {
    return false;
  }
  if (
    filters.hasError !== undefined &&
    (span.error !== null && span.error !== undefined) !== filters.hasError
  ) {
    return false;
  }

  for (const [path, expected] of metadataLeaves) {
    let actual: unknown = span.metadata;
    for (const key of path) {
      actual =
        isRecord(actual) && Object.hasOwn(actual, key)
          ? actual[key]
          : undefined;
    }
    if (!metadataEqual(actual, expected)) {
      return false;
    }
  }

  if (filters.duration && Object.keys(filters.duration).length > 0) {
    const metrics = span.metrics;
    const start = isRecord(metrics) ? metrics.start : undefined;
    const end = isRecord(metrics) ? metrics.end : undefined;
    if (
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      typeof end !== "number" ||
      !Number.isFinite(end)
    ) {
      return false;
    }
    const elapsed = end - start;
    if (filters.duration.min !== undefined && elapsed < filters.duration.min) {
      return false;
    }
    if (filters.duration.max !== undefined && elapsed > filters.duration.max) {
      return false;
    }
  }

  return true;
}

function btqlComparison(
  op: string,
  name: string[],
  value: unknown,
): BtqlExpression {
  return {
    op,
    left: { op: "ident", name },
    right: { op: "literal", value },
  };
}

function btqlNullCheck(op: string, name: string[]): BtqlExpression {
  return { op, expr: { op: "ident", name } };
}

function spanFilterClauses(
  compiledFilters: CompiledSpanFilters,
): BtqlExpression[] {
  const { filters, metadataLeaves } = compiledFilters;
  const children: BtqlExpression[] = [];
  for (const [field, attribute] of [
    ["spanType", "type"],
    ["name", "name"],
  ] as const) {
    const values = filters[field];
    if (values !== undefined) {
      // BTQL rejects IN []; an empty set of alternatives is always false.
      children.push(
        values.length > 0
          ? btqlComparison("in", ["span_attributes", attribute], values)
          : { op: "literal", value: false },
      );
    }
  }

  if (filters.hasError !== undefined) {
    children.push(
      btqlNullCheck(filters.hasError ? "isnotnull" : "isnull", ["error"]),
    );
  }

  for (const [path, value] of metadataLeaves) {
    const name = ["metadata", ...path];
    children.push(
      value === null
        ? btqlNullCheck("isnull", name)
        : btqlComparison("eq", name, value),
    );
  }

  const elapsed = {
    op: "sub",
    left: { op: "ident", name: ["metrics", "end"] },
    right: { op: "ident", name: ["metrics", "start"] },
  };
  if (filters.duration?.min !== undefined) {
    children.push({
      op: "ge",
      left: elapsed,
      right: { op: "literal", value: filters.duration.min },
    });
  }
  if (filters.duration?.max !== undefined) {
    children.push({
      op: "le",
      left: elapsed,
      right: { op: "literal", value: filters.duration.max },
    });
  }

  return children;
}

/**
 * Fetcher for spans by root_span_id, using the ObjectFetcher pattern.
 * Handles pagination automatically via cursor-based iteration.
 */
export class SpanFetcher extends ObjectFetcher<SpanRecord> {
  constructor(
    objectType: "experiment" | "project_logs" | "playground_logs",
    private readonly _objectId: string,
    // @ts-expect-error retained for constructor compatibility
    private readonly rootSpanId: string,
    private readonly _state: BraintrustState,
    // @ts-expect-error retained for constructor compatibility
    private readonly spanTypeFilter?: string[],
    includeScorers = false,
    brainstoreRealtime = true,
    filters?: SpanFilters,
  ) {
    const normalizedFilters = normalizeSpanFilters(filters, spanTypeFilter);
    const filterExpr = SpanFetcher.buildFilter(
      rootSpanId,
      normalizedFilters,
      includeScorers,
    );

    super(
      objectType,
      undefined,
      undefined,
      {
        filter: filterExpr,
      },
      brainstoreRealtime,
    );
  }

  private static buildFilter(
    rootSpanId: string,
    filters: CompiledSpanFilters,
    includeScorers = false,
  ): BtqlExpression {
    const purpose = ["span_attributes", "purpose"];
    const children: BtqlExpression[] = [
      btqlComparison("eq", ["root_span_id"], rootSpanId),
    ];

    if (!includeScorers) {
      children.push({
        op: "or",
        children: [
          btqlNullCheck("isnull", purpose),
          btqlComparison("ne", purpose, "scorer"),
        ],
      });
    }

    children.push(...spanFilterClauses(filters));
    return { op: "and", children };
  }

  public get id(): Promise<string> {
    return Promise.resolve(this._objectId);
  }

  protected async getState(): Promise<BraintrustState> {
    return this._state;
  }
}

/**
 * Span data returned by getSpans().
 */
export interface SpanData {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  span_id?: string;
  span_parents?: string[];
  span_attributes?: {
    type?: string;
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Function signature for fetching spans by type. */
export type SpanFetchFn = (
  spanType: string[] | undefined,
) => Promise<SpanData[]>;
type SpanFetchWithOptionsFn = (
  filters: CompiledSpanFilters,
  includeScorers: boolean,
) => Promise<SpanData[]>;

/**
 * Fetches spans for one root span, reusing complete results and results that
 * are authoritative for a requested span type. Advanced filtered results are
 * never cached because they do not represent every span of their type.
 */
export class CachedSpanFetcher {
  private spanCache = new Map<string, SpanData[]>();
  private allFetched = false;
  private fetchFn: SpanFetchWithOptionsFn;

  constructor(
    objectType: "experiment" | "project_logs" | "playground_logs",
    objectId: string,
    rootSpanId: string,
    getState: () => Promise<BraintrustState>,
    brainstoreRealtime?: boolean,
  );
  constructor(fetchFn: SpanFetchFn);
  constructor(
    objectTypeOrFetchFn:
      | "experiment"
      | "project_logs"
      | "playground_logs"
      | SpanFetchFn,
    objectId?: string,
    rootSpanId?: string,
    getState?: () => Promise<BraintrustState>,
    brainstoreRealtime = true,
  ) {
    if (typeof objectTypeOrFetchFn === "function") {
      // Preserve the original test/custom fetcher contract while applying
      // advanced filters locally to its returned spans.
      this.fetchFn = async (filters) =>
        (await objectTypeOrFetchFn(filters.filters.spanType)).filter((span) =>
          matchesSpanFilters(span, filters),
        );
    } else {
      const objectType = objectTypeOrFetchFn;
      this.fetchFn = async (filters, includeScorers) => {
        const state = await getState!();
        const fetcher = new SpanFetcher(
          objectType,
          objectId!,
          rootSpanId!,
          state,
          undefined,
          includeScorers,
          brainstoreRealtime,
          filters.filters,
        );
        let spans: SpanData[] = (await fetcher.fetchedData()).map(
          (row: WithTransactionId<SpanRecord>) => ({ ...row }),
        );
        // Backend metadata comparisons can coerce types. Keep exact local and
        // remote behavior aligned while still pushing the filter down.
        if (filters.filters.metadata !== undefined) {
          spans = spans.filter((span) => matchesSpanFilters(span, filters));
        }
        return spans;
      };
    }
  }

  async getSpans({
    spanType: requestedSpanType,
    filters,
    includeScorers = false,
  }: GetSpansOptions = {}): Promise<SpanData[]> {
    const normalizedFilters = normalizeSpanFilters(filters, requestedSpanType);
    const spanType = normalizedFilters.filters.spanType;
    const hasAdvancedFilters = Object.keys(normalizedFilters.filters).some(
      (field) => field !== "spanType",
    );

    if (spanType?.length === 0) {
      return [];
    }

    if (includeScorers) {
      return this.fetchFn(normalizedFilters, true);
    }

    // A complete cache can answer every supported filter locally.
    if (this.allFetched) {
      const spans = this.getFromCache(spanType);
      return hasAdvancedFilters
        ? spans.filter((span) => matchesSpanFilters(span, normalizedFilters))
        : spans;
    }

    // A typed cache is authoritative for each type it contains, so it can
    // answer advanced queries when every requested type is already present.
    if (
      hasAdvancedFilters &&
      spanType &&
      spanType.every((type) => this.spanCache.has(type))
    ) {
      return this.getFromCache(spanType).filter((span) =>
        matchesSpanFilters(span, normalizedFilters),
      );
    }

    // Other partial advanced results are pushed down and used once rather
    // than cached.
    if (hasAdvancedFilters) {
      return this.fetchFn(normalizedFilters, false);
    }

    if (!spanType) {
      // Avoid duplicating spans from an earlier typed fetch.
      this.spanCache.clear();
      await this.fetchSpans(undefined);
      if (this.spanCache.size > 0) {
        this.allFetched = true;
      }
      return this.getFromCache(undefined);
    }

    const missingTypes = spanType.filter((type) => !this.spanCache.has(type));
    if (missingTypes.length > 0) {
      await this.fetchSpans(missingTypes);
    }
    return this.getFromCache(spanType);
  }

  private async fetchSpans(spanType: string[] | undefined): Promise<void> {
    const spans = await this.fetchFn(
      normalizeSpanFilters(spanType ? { spanType } : undefined),
      false,
    );

    for (const span of spans) {
      const type = span.span_attributes?.type ?? "";
      const existing = this.spanCache.get(type) ?? [];
      existing.push(span);
      this.spanCache.set(type, existing);
    }
  }

  private getFromCache(spanType: string[] | undefined): SpanData[] {
    if (!spanType || spanType.length === 0) {
      return Array.from(this.spanCache.values()).flat();
    }

    const result: SpanData[] = [];
    for (const type of spanType) {
      const spans = this.spanCache.get(type);
      if (spans) result.push(...spans);
    }
    return result;
  }
}

/**
 * Options for getThread().
 */
export interface GetThreadOptions {
  /**
   * The preprocessor to use for extracting the thread.
   * If not specified, uses the project default preprocessor,
   * falling back to the global "thread" preprocessor.
   */
  preprocessor?: string;
}

export interface GetSpansOptions {
  /** Optional top-level span type filter. */
  spanType?: string[];
  /** Filters for span type, name, error state, metadata, and duration. */
  filters?: SpanFilters;
  includeScorers?: boolean;
}

/**
 * Interface for trace objects that can be used by scorers.
 * Both the SDK's LocalTrace class and the API wrapper's WrapperTrace implement this.
 */
export interface Trace {
  getConfiguration(): {
    object_type: string;
    object_id: string;
    root_span_id: string;
  };
  getSpans(options?: GetSpansOptions): Promise<SpanData[]>;
  /**
   * Get the thread (preprocessed messages) for this trace.
   * Uses the project default preprocessor, falling back to the global "thread" preprocessor.
   * @param options Options for the thread extraction.
   * @returns The preprocessed thread as an array of messages.
   */
  getThread(options?: GetThreadOptions): Promise<unknown[]>;
}

/**
 * SDK implementation of Trace that uses local span cache and falls back to BTQL.
 * Carries identifying information about the evaluation so scorers can perform
 * richer logging or side effects.
 */
export class LocalTrace implements Trace {
  private readonly objectType:
    | "experiment"
    | "project_logs"
    | "playground_logs";
  private readonly objectId: string;
  private readonly rootSpanId: string;
  private readonly ensureSpansFlushed?: () => Promise<void>;
  private readonly state: BraintrustState;
  private spansFlushed = false;
  private spansFlushPromise: Promise<void> | null = null;
  private cachedFetcher: CachedSpanFetcher;
  private threadCache: Map<string, Promise<unknown[]>> = new Map();

  constructor({
    objectType,
    objectId,
    rootSpanId,
    ensureSpansFlushed,
    state,
  }: TraceOptions) {
    this.objectType = objectType;
    this.objectId = objectId;
    this.rootSpanId = rootSpanId;
    this.ensureSpansFlushed = ensureSpansFlushed;
    this.state = state;
    this.cachedFetcher = new CachedSpanFetcher(
      objectType,
      objectId,
      rootSpanId,
      async () => {
        await this.ensureSpansReady();
        await state.login({});
        return state;
      },
    );
  }

  getConfiguration() {
    return {
      object_type: this.objectType,
      object_id: this.objectId,
      root_span_id: this.rootSpanId,
    };
  }

  /**
   * Custom JSON serialization - returns trace_ref format so LocalTrace
   * can be safely passed through JSON.stringify() (e.g., in invoke()).
   */
  toJSON() {
    return {
      trace_ref: {
        object_type: this.objectType,
        object_id: this.objectId,
        root_span_id: this.rootSpanId,
      },
    };
  }

  /**
   * Fetch all rows for this root span from its parent object (experiment or project logs).
   * First checks the local span cache for recently logged spans, then falls
   * back to CachedSpanFetcher which handles BTQL fetching and caching.
   */
  async getSpans({
    spanType,
    filters,
    includeScorers = false,
  }: GetSpansOptions = {}): Promise<SpanData[]> {
    const normalizedFilters = normalizeSpanFilters(filters, spanType);

    // Try local span cache first (for recently logged spans not yet flushed).
    const cachedSpans = this.state.spanCache.getByRootSpanId(this.rootSpanId);
    if (cachedSpans && cachedSpans.length > 0) {
      return cachedSpans
        .filter(
          (span) =>
            (includeScorers || span.span_attributes?.purpose !== "scorer") &&
            matchesSpanFilters({ ...span }, normalizedFilters),
        )
        .map((span) => ({ ...span }));
    }

    return this.cachedFetcher.getSpans({
      filters: normalizedFilters.filters,
      includeScorers,
    });
  }

  /**
   * Get the thread (preprocessed messages) for this trace.
   * Calls the API with the project_default preprocessor (which falls back to "thread").
   */
  async getThread(options?: GetThreadOptions): Promise<unknown[]> {
    const cacheKey = options?.preprocessor ?? "project_default";

    if (!this.threadCache.has(cacheKey)) {
      const promise = this.fetchThread(options);
      this.threadCache.set(cacheKey, promise);
    }

    return this.threadCache.get(cacheKey)!;
  }

  private async fetchThread(options?: GetThreadOptions): Promise<unknown[]> {
    await this.ensureSpansReady();
    await this.state.login({});

    const result = await invoke({
      globalFunction: options?.preprocessor ?? "project_default",
      functionType: "preprocessor",
      input: {
        trace_ref: {
          object_type: this.objectType,
          object_id: this.objectId,
          root_span_id: this.rootSpanId,
        },
      },
      mode: "json",
      state: this.state,
    });

    return Array.isArray(result) ? result : [];
  }

  private async ensureSpansReady() {
    if (this.spansFlushed || !this.ensureSpansFlushed) {
      return;
    }

    if (!this.spansFlushPromise) {
      this.spansFlushPromise = this.ensureSpansFlushed().then(
        () => {
          this.spansFlushed = true;
        },
        (err) => {
          this.spansFlushPromise = null;
          throw err;
        },
      );
    }

    await this.spansFlushPromise;
  }
}
