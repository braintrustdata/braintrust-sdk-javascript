import {
  describe,
  expect,
  test,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  CachedSpanFetcher,
  LocalTrace,
  SpanData,
  SpanFetchFn,
  SpanFilters,
} from "./trace";
import {
  _exportsForTestingOnly,
  _internalGetGlobalState,
  type BraintrustState,
} from "./logger";
import { configureNode } from "./node/config";

// Mock the invoke function
vi.mock("./functions/invoke", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "./functions/invoke";

describe("CachedSpanFetcher", () => {
  // Helper to create mock spans
  const makeSpan = (
    spanId: string,
    type: string,
    extra: Partial<SpanData> = {},
  ): SpanData => ({
    span_id: spanId,
    input: { text: `input-${spanId}` },
    output: { text: `output-${spanId}` },
    span_attributes: { type },
    ...extra,
  });

  describe("basic fetching", () => {
    test("should fetch all spans when no filter specified", async () => {
      const mockSpans = [
        makeSpan("span-1", "llm"),
        makeSpan("span-2", "function"),
        makeSpan("span-3", "llm"),
      ];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(mockSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      const result = await fetcher.getSpans();

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(undefined);
      expect(result).toHaveLength(3);
      // Order may differ since spans are grouped by type in cache
      expect(result.map((s) => s.span_id).sort()).toEqual([
        "span-1",
        "span-2",
        "span-3",
      ]);
    });

    test("should preserve result fields from BTQL rows", async () => {
      const post = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          data: [
            {
              id: "row-1",
              span_id: "span-1",
              root_span_id: "root-1",
              input: { text: "input" },
              output: { text: "output" },
              expected: { text: "expected" },
              error: { message: "boom" },
              scores: { quality: 0 },
              metrics: { start: 1, end: 2 },
              metadata: { source: "test" },
              tags: ["debug"],
              is_root: true,
              span_attributes: { type: "tool" },
            },
          ],
          cursor: null,
        }),
      });
      const state = {
        apiConn: () => ({ post }),
      } as unknown as BraintrustState;
      const fetcher = new CachedSpanFetcher(
        "project_logs",
        "project-1",
        "root-1",
        async () => state,
      );

      const result = await fetcher.getSpans();

      expect(result[0]).toMatchObject({
        error: { message: "boom" },
        scores: { quality: 0 },
        metrics: { start: 1, end: 2 },
        tags: ["debug"],
        is_root: true,
      });
    });

    test("should thread brainstore realtime setting to BTQL fetches", async () => {
      const post = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          data: [],
          cursor: null,
        }),
      });
      const state = {
        apiConn: () => ({ post }),
      } as unknown as BraintrustState;
      const fetcher = new CachedSpanFetcher(
        "project_logs",
        "project-1",
        "root-1",
        async () => state,
        false,
      );

      await fetcher.getSpans();

      expect(post.mock.calls[0][1]).toMatchObject({
        brainstore_realtime: false,
      });
    });

    test("should push advanced filters into the BTQL query", async () => {
      const post = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ data: [], cursor: null }),
      });
      const state = {
        apiConn: () => ({ post }),
      } as unknown as BraintrustState;
      const fetcher = new CachedSpanFetcher(
        "project_logs",
        "project-1",
        "root-1",
        async () => state,
      );

      await fetcher.getSpans({
        filters: {
          spanType: ["tool"],
          name: ["search", "lookup"],
          hasError: true,
          metadata: { request: { model: "gpt-5" } },
          duration: { min: 0.5, max: 10 },
        },
      });

      const filter = post.mock.calls[0][1].query.filter;
      expect(filter).toEqual({
        op: "and",
        children: [
          {
            op: "eq",
            left: { op: "ident", name: ["root_span_id"] },
            right: { op: "literal", value: "root-1" },
          },
          {
            op: "or",
            children: [
              {
                op: "isnull",
                expr: {
                  op: "ident",
                  name: ["span_attributes", "purpose"],
                },
              },
              {
                op: "ne",
                left: {
                  op: "ident",
                  name: ["span_attributes", "purpose"],
                },
                right: { op: "literal", value: "scorer" },
              },
            ],
          },
          {
            op: "in",
            left: { op: "ident", name: ["span_attributes", "type"] },
            right: { op: "literal", value: ["tool"] },
          },
          {
            op: "in",
            left: { op: "ident", name: ["span_attributes", "name"] },
            right: { op: "literal", value: ["search", "lookup"] },
          },
          {
            op: "isnotnull",
            expr: { op: "ident", name: ["error"] },
          },
          {
            op: "eq",
            left: {
              op: "ident",
              name: ["metadata", "request", "model"],
            },
            right: { op: "literal", value: "gpt-5" },
          },
          {
            op: "ge",
            left: {
              op: "sub",
              left: { op: "ident", name: ["metrics", "end"] },
              right: { op: "ident", name: ["metrics", "start"] },
            },
            right: { op: "literal", value: 0.5 },
          },
          {
            op: "le",
            left: {
              op: "sub",
              left: { op: "ident", name: ["metrics", "end"] },
              right: { op: "ident", name: ["metrics", "start"] },
            },
            right: { op: "literal", value: 10 },
          },
        ],
      });
    });

    test("should recheck metadata without backend type coercion", async () => {
      const post = vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          data: [
            makeSpan("boolean", "tool", { metadata: { flag: true } }),
            makeSpan("number", "tool", { metadata: { flag: 1 } }),
          ],
          cursor: null,
        }),
      });
      const state = {
        apiConn: () => ({ post }),
      } as unknown as BraintrustState;
      const fetcher = new CachedSpanFetcher(
        "project_logs",
        "project-1",
        "root-1",
        async () => state,
      );

      const result = await fetcher.getSpans({
        filters: { metadata: { flag: true } },
      });

      expect(result.map((span) => span.span_id)).toEqual(["boolean"]);
    });

    test("should fetch specific span types when filter specified", async () => {
      const llmSpans = [makeSpan("span-1", "llm"), makeSpan("span-2", "llm")];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(llmSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      const result = await fetcher.getSpans({ spanType: ["llm"] });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(["llm"]);
      expect(result).toHaveLength(2);
    });
  });

  describe("caching behavior", () => {
    test("should return cached spans without re-fetching after fetching all", async () => {
      const mockSpans = [
        makeSpan("span-1", "llm"),
        makeSpan("span-2", "function"),
      ];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(mockSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      // First call - fetches
      await fetcher.getSpans();
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result = await fetcher.getSpans();
      expect(fetchFn).toHaveBeenCalledTimes(1); // Still 1
      expect(result).toHaveLength(2);
    });

    test("should return cached spans for previously fetched types", async () => {
      const llmSpans = [makeSpan("span-1", "llm"), makeSpan("span-2", "llm")];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(llmSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      // First call - fetches llm spans
      await fetcher.getSpans({ spanType: ["llm"] });
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Second call for same type - should use cache
      const result = await fetcher.getSpans({ spanType: ["llm"] });
      expect(fetchFn).toHaveBeenCalledTimes(1); // Still 1
      expect(result).toHaveLength(2);
    });

    test("should only fetch missing span types", async () => {
      const llmSpans = [makeSpan("span-1", "llm")];
      const functionSpans = [makeSpan("span-2", "function")];

      const fetchFn = vi
        .fn<SpanFetchFn>()
        .mockResolvedValueOnce(llmSpans)
        .mockResolvedValueOnce(functionSpans);

      const fetcher = new CachedSpanFetcher(fetchFn);

      // First call - fetches llm spans
      await fetcher.getSpans({ spanType: ["llm"] });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenLastCalledWith(["llm"]);

      // Second call for both types - should only fetch function
      const result = await fetcher.getSpans({ spanType: ["llm", "function"] });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn).toHaveBeenLastCalledWith(["function"]);
      expect(result).toHaveLength(2);
    });

    test("should not re-fetch after fetching all spans", async () => {
      const allSpans = [
        makeSpan("span-1", "llm"),
        makeSpan("span-2", "function"),
        makeSpan("span-3", "tool"),
      ];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(allSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      // Fetch all spans
      await fetcher.getSpans();
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Subsequent filtered calls should use cache
      const llmResult = await fetcher.getSpans({ spanType: ["llm"] });
      expect(fetchFn).toHaveBeenCalledTimes(1); // Still 1
      expect(llmResult).toHaveLength(1);
      expect(llmResult[0].span_id).toBe("span-1");

      const functionResult = await fetcher.getSpans({ spanType: ["function"] });
      expect(fetchFn).toHaveBeenCalledTimes(1); // Still 1
      expect(functionResult).toHaveLength(1);
      expect(functionResult[0].span_id).toBe("span-2");
    });
  });

  describe("filtering from cache", () => {
    test("should filter by multiple span types from cache", async () => {
      const allSpans = [
        makeSpan("span-1", "llm"),
        makeSpan("span-2", "function"),
        makeSpan("span-3", "tool"),
        makeSpan("span-4", "llm"),
      ];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(allSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      // Fetch all first
      await fetcher.getSpans();

      // Filter for llm and tool
      const result = await fetcher.getSpans({ spanType: ["llm", "tool"] });
      expect(result).toHaveLength(3);
      expect(result.map((s) => s.span_id).sort()).toEqual([
        "span-1",
        "span-3",
        "span-4",
      ]);
    });

    test("should return empty array for non-existent span type", async () => {
      const allSpans = [makeSpan("span-1", "llm")];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(allSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      // Fetch all first
      await fetcher.getSpans();

      // Query for non-existent type
      const result = await fetcher.getSpans({ spanType: ["nonexistent"] });
      expect(result).toHaveLength(0);
    });

    test("should handle spans with no type (empty string type)", async () => {
      const spans = [
        makeSpan("span-1", "llm"),
        { span_id: "span-2", input: {}, span_attributes: {} }, // No type
        { span_id: "span-3", input: {} }, // No span_attributes
      ];

      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(spans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      // Fetch all
      const result = await fetcher.getSpans();
      expect(result).toHaveLength(3);

      // Spans without type go into "" bucket
      const noTypeResult = await fetcher.getSpans({ spanType: [""] });
      expect(noTypeResult).toHaveLength(2);
    });
  });

  describe("advanced filters", () => {
    const spans = [
      makeSpan("search", "tool", {
        span_attributes: { type: "tool", name: "search" },
        metadata: {
          request: { region: "us", model: null },
          flag: true,
        },
        metrics: { start: 100, end: 102 },
      }),
      makeSpan("failed", "tool", {
        span_attributes: { type: "tool", name: "search" },
        error: "failed",
        metadata: { request: { region: "eu" }, flag: 1 },
        metrics: { start: 100, end: 105 },
      }),
      makeSpan("lookup", "llm", {
        span_attributes: { type: "llm", name: "lookup" },
        error: "",
        metadata: { request: {} },
        metrics: { start: 100, end: 100.5 },
      }),
      makeSpan("open", "tool", {
        span_attributes: { type: "tool", name: "open" },
        metrics: { start: 100 },
      }),
    ];

    test.each<[SpanFilters, string[]]>([
      [{ spanType: ["tool"] }, ["failed", "open", "search"]],
      [{ name: ["search", "lookup"] }, ["failed", "lookup", "search"]],
      [{ hasError: true }, ["failed", "lookup"]],
      [{ hasError: false }, ["open", "search"]],
      [{ metadata: { request: { region: "us" } } }, ["search"]],
      [
        { metadata: { request: { model: null } } },
        ["failed", "lookup", "open", "search"],
      ],
      [{ metadata: { flag: true } }, ["search"]],
      [{ metadata: { flag: 1 } }, ["failed"]],
      [{ duration: { min: 2, max: 5 } }, ["failed", "search"]],
      [{ duration: { max: 0.5 } }, ["lookup"]],
      [{ name: [] }, []],
      [{ spanType: [] }, []],
      [{ metadata: {} }, ["failed", "lookup", "open", "search"]],
      [{ metadata: { request: {} } }, ["failed", "lookup", "open", "search"]],
      [{ duration: {} }, ["failed", "lookup", "open", "search"]],
      [{ duration: { min: 5, max: 2 } }, []],
    ])("filters a complete cache with %j", async (filters, expected) => {
      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(spans);
      const fetcher = new CachedSpanFetcher(fetchFn);
      await fetcher.getSpans();

      const result = await fetcher.getSpans({ filters });

      expect(result.map((span) => span.span_id).sort()).toEqual(expected);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test("reuses authoritative typed cache entries for advanced filters", async () => {
      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(spans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      await fetcher.getSpans({ spanType: ["tool"] });
      const result = await fetcher.getSpans({
        filters: { spanType: ["tool"], name: ["search"], hasError: false },
      });

      expect(result.map((span) => span.span_id)).toEqual(["search"]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test("does not cache partial advanced-filter results", async () => {
      const matching = [spans[0]];
      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(matching);
      const fetcher = new CachedSpanFetcher(fetchFn);
      const filters: SpanFilters = {
        spanType: ["tool"],
        name: ["search"],
        hasError: false,
      };

      expect(await fetcher.getSpans({ filters })).toEqual(matching);
      expect(await fetcher.getSpans({ filters })).toEqual(matching);
      expect(fetchFn).toHaveBeenNthCalledWith(1, ["tool"]);
      expect(fetchFn).toHaveBeenNthCalledWith(2, ["tool"]);
    });

    test("does not duplicate typed results after a complete fetch", async () => {
      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(spans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      await fetcher.getSpans({ spanType: ["tool"] });
      const result = await fetcher.getSpans();

      expect(result.map((span) => span.span_id).sort()).toEqual([
        "failed",
        "lookup",
        "open",
        "search",
      ]);
    });

    test.each([
      [{ spanType: "tool" }, "spanType"],
      [{ name: [1] }, "name"],
      [{ hasError: "yes" }, "hasError"],
      [{ metadata: [] }, "metadata"],
      [{ metadata: { value: undefined } }, "JSON-serializable"],
      [{ metadata: { value: BigInt(1) } }, "JSON-serializable"],
      [{ metadata: { value: () => undefined } }, "JSON-serializable"],
      [{ metadata: { value: Number.NaN } }, "finite"],
      [{ duration: { min: "slow" } }, "duration"],
      [{ duration: { min: Number.NaN } }, "duration"],
      [{ duration: { minimum: 1 } }, "duration"],
      [{ unknown: true }, "Unsupported"],
    ])("rejects invalid filters", async (filters, message) => {
      const fetcher = new CachedSpanFetcher(vi.fn<SpanFetchFn>());
      await expect(
        fetcher.getSpans({ filters: filters as SpanFilters }),
      ).rejects.toThrow(message as string);
    });

    test("rejects cyclic metadata filters", async () => {
      const metadata: Record<string, unknown> = {};
      metadata.self = metadata;
      const fetcher = new CachedSpanFetcher(vi.fn<SpanFetchFn>());

      await expect(fetcher.getSpans({ filters: { metadata } })).rejects.toThrow(
        "cycles",
      );
    });
  });

  describe("edge cases", () => {
    test("should not cache empty results", async () => {
      const fetchFn = vi
        .fn<SpanFetchFn>()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeSpan("span-1", "llm")]);
      const fetcher = new CachedSpanFetcher(fetchFn);

      expect(await fetcher.getSpans()).toEqual([]);
      expect(await fetcher.getSpans()).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    test("should handle empty spanType array same as undefined", async () => {
      const mockSpans = [makeSpan("span-1", "llm")];
      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue(mockSpans);
      const fetcher = new CachedSpanFetcher(fetchFn);

      const result = await fetcher.getSpans({ spanType: [] });

      expect(fetchFn).toHaveBeenCalledWith(undefined);
      expect(result).toHaveLength(1);
    });
  });
});

describe("LocalTrace.getSpans", () => {
  beforeAll(() => {
    configureNode();
    _exportsForTestingOnly.setInitialTestState();
  });

  afterEach(() => {
    const state = _internalGetGlobalState();
    state.spanCache.clearAll();
    state.spanCache.stop();
  });

  test("should apply filters consistently to locally cached spans", async () => {
    const state = _internalGetGlobalState();
    state.spanCache.start();
    const rootSpanId = "root-filtered";
    const spans = [
      {
        span_id: "search",
        span_attributes: { type: "tool", name: "search" },
        metadata: { request: { region: "us", model: null }, flag: true },
        metrics: { start: 100, end: 102 },
      },
      {
        span_id: "failed",
        span_attributes: { type: "tool", name: "search" },
        metadata: { request: { region: "eu" }, flag: 1 },
        metrics: { start: 100, end: 105 },
        error: "failed",
      },
      {
        span_id: "scorer",
        span_attributes: {
          type: "score",
          name: "search",
          purpose: "scorer",
        },
      },
    ];
    for (const span of spans) {
      state.spanCache.queueWrite(rootSpanId, span.span_id, span);
    }
    const trace = new LocalTrace({
      objectType: "experiment",
      objectId: "exp-123",
      rootSpanId,
      state,
    });

    expect(
      (
        await trace.getSpans({
          filters: {
            spanType: ["tool"],
            name: ["search"],
            metadata: { request: { model: null } },
            duration: { min: 2, max: 2 },
            hasError: false,
          },
        })
      ).map((span) => span.span_id),
    ).toEqual(["search"]);
    expect(
      (
        await trace.getSpans({
          filters: { name: ["search"] },
          includeScorers: true,
        })
      )
        .map((span) => span.span_id)
        .sort(),
    ).toEqual(["failed", "scorer", "search"]);
    expect(
      (await trace.getSpans({ spanType: ["tool"] })).map(
        (span) => span.span_id,
      ),
    ).toEqual(["search", "failed"]);
    expect(
      (
        await trace.getSpans({
          spanType: ["tool"],
          filters: { hasError: true },
        })
      ).map((span) => span.span_id),
    ).toEqual(["failed"]);
    await expect(
      trace.getSpans({
        spanType: ["tool"],
        filters: { spanType: ["llm"] },
      }),
    ).rejects.toThrow("spanType");
  });

  test("should preserve cached span result fields", async () => {
    const state = _internalGetGlobalState();
    state.spanCache.start();
    state.spanCache.queueWrite("root-cached", "span-1", {
      span_id: "span-1",
      error: { message: "boom" },
      scores: { quality: 0 },
      metrics: { start: 1, end: 2 },
      tags: ["debug"],
      is_root: true,
      span_attributes: { type: "tool" },
    });
    const trace = new LocalTrace({
      objectType: "experiment",
      objectId: "exp-123",
      rootSpanId: "root-cached",
      state,
    });

    const result = await trace.getSpans();

    expect(result[0]).toMatchObject({
      error: { message: "boom" },
      scores: { quality: 0 },
      metrics: { start: 1, end: 2 },
      tags: ["debug"],
      is_root: true,
    });
  });
});

describe("LocalTrace.getThread", () => {
  const mockedInvoke = vi.mocked(invoke);

  beforeAll(async () => {
    configureNode();
    _exportsForTestingOnly.setInitialTestState();
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("should call invoke with correct parameters", async () => {
    const mockThread = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    mockedInvoke.mockResolvedValue(mockThread);

    const trace = new LocalTrace({
      objectType: "experiment",
      objectId: "exp-123",
      rootSpanId: "root-456",
      state: _internalGetGlobalState(),
    });

    const result = await trace.getThread();

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        globalFunction: "project_default",
        functionType: "preprocessor",
        mode: "json",
        input: {
          trace_ref: {
            object_type: "experiment",
            object_id: "exp-123",
            root_span_id: "root-456",
          },
        },
      }),
    );
    expect(result).toEqual(mockThread);
  });

  test("should use custom preprocessor when specified", async () => {
    const mockThread = [{ role: "user", content: "Test" }];
    mockedInvoke.mockResolvedValue(mockThread);

    const trace = new LocalTrace({
      objectType: "project_logs",
      objectId: "proj-789",
      rootSpanId: "root-abc",
      state: _internalGetGlobalState(),
    });

    await trace.getThread({ preprocessor: "custom_preprocessor" });

    expect(mockedInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        globalFunction: "custom_preprocessor",
        functionType: "preprocessor",
      }),
    );
  });

  test("should cache results for same preprocessor", async () => {
    const mockThread = [{ role: "user", content: "Cached" }];
    mockedInvoke.mockResolvedValue(mockThread);

    const trace = new LocalTrace({
      objectType: "experiment",
      objectId: "exp-123",
      rootSpanId: "root-456",
      state: _internalGetGlobalState(),
    });

    // First call
    const result1 = await trace.getThread();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);

    // Second call - should use cache
    const result2 = await trace.getThread();
    expect(mockedInvoke).toHaveBeenCalledTimes(1); // Still 1

    expect(result1).toEqual(result2);
  });

  test("should cache separately for different preprocessors", async () => {
    const defaultThread = [{ role: "user", content: "Default" }];
    const customThread = [{ role: "user", content: "Custom" }];

    mockedInvoke
      .mockResolvedValueOnce(defaultThread)
      .mockResolvedValueOnce(customThread);

    const trace = new LocalTrace({
      objectType: "experiment",
      objectId: "exp-123",
      rootSpanId: "root-456",
      state: _internalGetGlobalState(),
    });

    // Call with default preprocessor
    const result1 = await trace.getThread();
    expect(result1).toEqual(defaultThread);

    // Call with custom preprocessor - should fetch again
    const result2 = await trace.getThread({ preprocessor: "custom" });
    expect(result2).toEqual(customThread);

    expect(mockedInvoke).toHaveBeenCalledTimes(2);

    // Call with default again - should use cache
    const result3 = await trace.getThread();
    expect(result3).toEqual(defaultThread);
    expect(mockedInvoke).toHaveBeenCalledTimes(2); // Still 2
  });

  test("should return empty array when invoke returns non-array", async () => {
    mockedInvoke.mockResolvedValue(null);

    const trace = new LocalTrace({
      objectType: "experiment",
      objectId: "exp-123",
      rootSpanId: "root-456",
      state: _internalGetGlobalState(),
    });

    const result = await trace.getThread();
    expect(result).toEqual([]);
  });

  test("should return empty array when invoke returns string", async () => {
    mockedInvoke.mockResolvedValue("some text result");

    const trace = new LocalTrace({
      objectType: "experiment",
      objectId: "exp-123",
      rootSpanId: "root-456",
      state: _internalGetGlobalState(),
    });

    const result = await trace.getThread();
    expect(result).toEqual([]);
  });
});
