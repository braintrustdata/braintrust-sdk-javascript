import {
  describe,
  expect,
  test,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { CachedSpanFetcher, LocalTrace, SpanData, SpanFetchFn } from "./trace";
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

  describe("edge cases", () => {
    test("should handle empty results", async () => {
      const fetchFn = vi.fn<SpanFetchFn>().mockResolvedValue([]);
      const fetcher = new CachedSpanFetcher(fetchFn);

      const result = await fetcher.getSpans();
      expect(result).toHaveLength(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Should still mark as fetched
      await fetcher.getSpans({ spanType: ["llm"] });
      expect(fetchFn).toHaveBeenCalledTimes(1); // Cache hit
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
