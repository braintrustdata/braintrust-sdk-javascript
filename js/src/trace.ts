import { BraintrustState, ObjectFetcher, WithTransactionId } from "./logger";
import { invoke } from "./functions/invoke";

export interface TraceOptions {
  objectType: "experiment" | "project_logs" | "playground_logs";
  objectId: string;
  rootSpanId: string;
  ensureSpansFlushed?: () => Promise<void>;
  state: BraintrustState;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpanRecord = any;

/**
 * Fetcher for spans by root_span_id, using the ObjectFetcher pattern.
 * Handles pagination automatically via cursor-based iteration.
 */
export class SpanFetcher extends ObjectFetcher<SpanRecord> {
  constructor(
    objectType: "experiment" | "project_logs" | "playground_logs",
    private readonly _objectId: string,
    private readonly rootSpanId: string,
    private readonly _state: BraintrustState,
    private readonly spanTypeFilter?: string[],
    includeScorers = false,
  ) {
    // Build the filter expression for root_span_id and optionally span_attributes.type
    const filterExpr = SpanFetcher.buildFilter(
      rootSpanId,
      spanTypeFilter,
      includeScorers,
    );

    super(objectType, undefined, undefined, {
      filter: filterExpr,
    });
  }

  private static buildFilter(
    rootSpanId: string,
    spanTypeFilter?: string[],
    includeScorers = false,
  ): Record<string, unknown> {
    const children: Record<string, unknown>[] = [
      // Base filter: root_span_id = 'value'
      {
        op: "eq",
        left: { op: "ident", name: ["root_span_id"] },
        right: { op: "literal", value: rootSpanId },
      },
    ];

    if (!includeScorers) {
      children.push({
        op: "or",
        children: [
          {
            op: "isnull",
            expr: { op: "ident", name: ["span_attributes", "purpose"] },
          },
          {
            op: "ne",
            left: { op: "ident", name: ["span_attributes", "purpose"] },
            right: { op: "literal", value: "scorer" },
          },
        ],
      });
    }

    // If no spanType filter, just return root_span_id filter
    if (spanTypeFilter && spanTypeFilter.length > 0) {
      // Add span_attributes.type IN [...] filter
      children.push({
        op: "in",
        left: { op: "ident", name: ["span_attributes", "type"] },
        right: { op: "literal", value: spanTypeFilter },
      });
    }

    // Combine with AND
    return {
      op: "and",
      children,
    };
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
  expected?: unknown;
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

/** Function signature for fetching spans by type */
export type SpanFetchFn = (
  spanType: string[] | undefined,
) => Promise<SpanData[]>;
export type SpanFetchWithOptionsFn = (
  spanType: string[] | undefined,
  includeScorers: boolean,
) => Promise<SpanData[]>;

/**
 * Cached span fetcher that handles fetching and caching spans by type.
 *
 * Caching strategy:
 * - Cache spans by span type (Map<spanType, SpanData[]>)
 * - Track if all spans have been fetched (allFetched flag)
 * - When filtering by spanType, only fetch types not already in cache
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
  ) {
    if (typeof objectTypeOrFetchFn === "function") {
      // Direct fetch function injection (for testing)
      this.fetchFn = (spanType) => objectTypeOrFetchFn(spanType);
    } else {
      // Standard constructor with SpanFetcher
      const objectType = objectTypeOrFetchFn;
      this.fetchFn = async (spanType, includeScorers) => {
        const state = await getState!();
        const fetcher = new SpanFetcher(
          objectType,
          objectId!,
          rootSpanId!,
          state,
          spanType,
          includeScorers,
        );
        const rows: WithTransactionId<SpanRecord>[] =
          await fetcher.fetchedData();
        return rows.map((row) => ({
          input: row.input,
          output: row.output,
          expected: row.expected,
          metadata: row.metadata,
          span_id: row.span_id,
          span_parents: row.span_parents,
          span_attributes: row.span_attributes,
          id: row.id,
          _xact_id: row._xact_id,
          _pagination_key: row._pagination_key,
          root_span_id: row.root_span_id,
          created: row.created,
          tags: row.tags,
        }));
      };
    }
  }

  async getSpans({
    spanType,
    includeScorers = false,
  }: { spanType?: string[]; includeScorers?: boolean } = {}): Promise<
    SpanData[]
  > {
    if (includeScorers) {
      return this.fetchFn(spanType, true);
    }

    // If we've fetched all spans, just filter from cache
    if (this.allFetched) {
      return this.getFromCache(spanType);
    }

    // If no filter requested, fetch everything
    if (!spanType || spanType.length === 0) {
      await this.fetchSpans(undefined);
      this.allFetched = true;
      return this.getFromCache(undefined);
    }

    // Find which spanTypes we don't have in cache yet
    const missingTypes = spanType.filter((t) => !this.spanCache.has(t));

    // If all requested types are cached, return from cache
    if (missingTypes.length === 0) {
      return this.getFromCache(spanType);
    }

    // Fetch only the missing types
    await this.fetchSpans(missingTypes);
    return this.getFromCache(spanType);
  }

  private async fetchSpans(spanType: string[] | undefined): Promise<void> {
    const spans = await this.fetchFn(spanType, false);

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
  getSpans(options?: {
    spanType?: string[];
    includeScorers?: boolean;
  }): Promise<SpanData[]>;
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
    includeScorers = false,
  }: { spanType?: string[]; includeScorers?: boolean } = {}): Promise<
    SpanData[]
  > {
    // Try local span cache first (for recently logged spans not yet flushed)
    const cachedSpans = this.state.spanCache.getByRootSpanId(this.rootSpanId);
    if (cachedSpans && cachedSpans.length > 0) {
      let spans = includeScorers
        ? cachedSpans
        : cachedSpans.filter(
            (span) => span.span_attributes?.purpose !== "scorer",
          );

      if (spanType && spanType.length > 0) {
        spans = spans.filter((span) =>
          spanType.includes(span.span_attributes?.type ?? ""),
        );
      }

      return spans.map((span) => ({
        input: span.input,
        output: span.output,
        expected: span.expected,
        metadata: span.metadata,
        span_id: span.span_id,
        span_parents: span.span_parents,
        span_attributes: span.span_attributes,
      }));
    }

    // Fall back to CachedSpanFetcher for BTQL fetching with caching
    return this.cachedFetcher.getSpans({ spanType, includeScorers });
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
