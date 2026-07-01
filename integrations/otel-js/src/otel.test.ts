/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { describe, it, expect, beforeEach, afterEach, vi, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { trace, context, Tracer, propagation } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
  CompositePropagator,
} from "@opentelemetry/core";
import {
  AISpanProcessor,
  BraintrustSpanProcessor,
  BraintrustExporter,
  addSpanParentToBaggage,
  addParentToBaggage,
  parentFromHeaders,
  isRootSpan,
} from "./otel";
import { _exportsForTestingOnly, initLogger } from "braintrust";
import {
  base64ToUint8Array,
  getExportVersion,
  createTracerProvider,
} from "../tests/utils";
import { SpanComponentsV3, SpanComponentsV4 } from "braintrust/util";
import { setupOtelCompat, resetOtelCompat } from ".";

async function withEmptyBraintrustEnvFile<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(tmpdir(), "braintrust-otel-env-"));
  try {
    await writeFile(path.join(tempDir, ".env.braintrust"), "");
    process.chdir(tempDir);
    return fn();
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { force: true, recursive: true });
  }
}

describe("AISpanProcessor", () => {
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let filterProcessor: AISpanProcessor;
  let tracer: Tracer;
  let baseProcessor: SimpleSpanProcessor;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();

    // Create processor with our filtering logic
    baseProcessor = new SimpleSpanProcessor(memoryExporter);
    filterProcessor = new AISpanProcessor(baseProcessor);

    provider = createTracerProvider(BasicTracerProvider, [filterProcessor]);

    // Don't set global tracer provider - use local one instead
    tracer = provider.getTracer("test_tracer");
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it("should filter out root spans that do not match AI prefixes", () => {
    const span = tracer.startSpan("root_operation");
    span.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(0);
  });

  it("should keep spans with filtered name prefixes", async () => {
    const rootSpan = tracer.startSpan("root");

    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    const genAiSpan = tracer.startSpan("gen_ai.completion", {}, parentContext);
    const braintrustSpan = tracer.startSpan(
      "braintrust.eval",
      {},
      parentContext,
    );
    const llmSpan = tracer.startSpan("llm.generate", {}, parentContext);
    const aiSpan = tracer.startSpan("ai.model_call", {}, parentContext);
    const traceloopSpan = tracer.startSpan(
      "traceloop.agent",
      {},
      parentContext,
    );
    const regularSpan = tracer.startSpan("database_query", {}, parentContext);

    genAiSpan.end();
    braintrustSpan.end();
    llmSpan.end();
    aiSpan.end();
    traceloopSpan.end();
    regularSpan.end();
    rootSpan.end();

    // Force flush to ensure spans are processed
    await provider.forceFlush();

    const spans = memoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    // root should be filtered out (not AI prefix)
    expect(spanNames).not.toContain("root");
    expect(spanNames).toContain("gen_ai.completion");
    expect(spanNames).toContain("braintrust.eval");
    expect(spanNames).toContain("llm.generate");
    expect(spanNames).toContain("ai.model_call");
    expect(spanNames).toContain("traceloop.agent");
    // database_query should be filtered out as it doesn't match filtered prefixes
    expect(spanNames).not.toContain("database_query");
  });

  it("should keep spans with filtered attribute prefixes", async () => {
    const rootSpan = tracer.startSpan("root");

    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    // This span should be kept because of its attribute prefix
    const genAiAttrSpan = tracer.startSpan(
      "some.operation",
      { attributes: { "gen_ai.model": "gpt-4" } },
      parentContext,
    );
    // This span should be kept because of its attribute prefix
    const llmAttrSpan = tracer.startSpan(
      "some.operation",
      { attributes: { "llm.temperature": 0.7 } },
      parentContext,
    );
    // This span should NOT be kept (no matching attribute prefix)
    const regularAttrSpan = tracer.startSpan(
      "some.operation",
      { attributes: { foo: "bar" } },
      parentContext,
    );

    genAiAttrSpan.end();
    llmAttrSpan.end();
    regularAttrSpan.end();
    rootSpan.end();

    await provider.forceFlush();

    const spans = memoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    // root should be filtered out (not AI prefix)
    expect(spanNames).not.toContain("root");
    expect(spanNames).toContain("some.operation"); // for both AI attribute prefix spans
    // There should be two kept (one for each AI attribute prefix)
    const aiAttrSpans = spans.filter(
      (s) =>
        s.attributes["gen_ai.model"] === "gpt-4" ||
        s.attributes["llm.temperature"] === 0.7,
    );
    expect(aiAttrSpans).toHaveLength(2);
    // The regular span should be filtered out
    expect(spans.find((s) => s.attributes["foo"] === "bar")).toBeUndefined();
  });

  it("should support custom filter that keeps root spans using isRootSpan", () => {
    const customFilter = (span: ReadableSpan) => {
      return isRootSpan(span) ? true : undefined;
    };

    const customMemoryExporter = new InMemorySpanExporter();
    const customFilterProcessor = new AISpanProcessor(
      new SimpleSpanProcessor(customMemoryExporter),
      customFilter,
    );
    const customProvider = createTracerProvider(BasicTracerProvider, [
      customFilterProcessor,
    ]);
    const customTracer = customProvider.getTracer("custom_test_tracer");

    const rootSpan = customTracer.startSpan("root");
    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    const childSpan = customTracer.startSpan("child", {}, parentContext);
    childSpan.end();
    rootSpan.end();

    const spans = customMemoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    expect(spanNames).toContain("root");
    expect(spanNames).not.toContain("child");

    customProvider.shutdown();
  });

  it("should support custom filter that keeps only root spans and AI spans", () => {
    const customFilter = (span: ReadableSpan) => {
      if (isRootSpan(span)) return true;
      return undefined;
    };

    const customMemoryExporter = new InMemorySpanExporter();
    const customFilterProcessor = new AISpanProcessor(
      new SimpleSpanProcessor(customMemoryExporter),
      customFilter,
    );
    const customProvider = createTracerProvider(BasicTracerProvider, [
      customFilterProcessor,
    ]);
    const customTracer = customProvider.getTracer("custom_test_tracer");

    const rootSpan = customTracer.startSpan("root");
    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    const aiSpan = customTracer.startSpan(
      "gen_ai.completion",
      {},
      parentContext,
    );
    const regularSpan = customTracer.startSpan(
      "regular_operation",
      {},
      parentContext,
    );
    aiSpan.end();
    regularSpan.end();
    rootSpan.end();

    const spans = customMemoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    expect(spanNames).toContain("root");
    expect(spanNames).toContain("gen_ai.completion");
    expect(spanNames).not.toContain("regular_operation");

    customProvider.shutdown();
  });

  it("should support custom filter that keeps spans", () => {
    const customFilter = (span: ReadableSpan) => {
      return span.name.includes("keep") ? true : undefined;
    };

    const customMemoryExporter = new InMemorySpanExporter();
    const customFilterProcessor = new AISpanProcessor(
      new SimpleSpanProcessor(customMemoryExporter),
      customFilter,
    );
    const customProvider = createTracerProvider(BasicTracerProvider, [
      customFilterProcessor,
    ]);
    const customTracer = customProvider.getTracer("custom_test_tracer");

    const rootSpan = customTracer.startSpan("root");

    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    const keepSpan = customTracer.startSpan("custom_keep", {}, parentContext);
    const regularSpan = customTracer.startSpan(
      "regular_operation",
      {},
      parentContext,
    );

    keepSpan.end();
    regularSpan.end();
    rootSpan.end();

    const spans = customMemoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    expect(spanNames).not.toContain("root");
    expect(spanNames).toContain("custom_keep"); // kept by custom filter
    expect(spanNames).not.toContain("regular_operation"); // dropped by default logic

    customProvider.shutdown();
  });

  it("should support custom filter that drops spans", () => {
    const customFilter = (span: ReadableSpan) => {
      return span.name.includes("drop") ? false : undefined;
    };

    const customMemoryExporter = new InMemorySpanExporter();
    const customFilterProcessor = new AISpanProcessor(
      new SimpleSpanProcessor(customMemoryExporter),
      customFilter,
    );
    const customProvider = createTracerProvider(BasicTracerProvider, [
      customFilterProcessor,
    ]);
    const customTracer = customProvider.getTracer("custom_test_tracer");

    const rootSpan = customTracer.startSpan("root");

    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    const dropSpan = customTracer.startSpan(
      "gen_ai.drop_this",
      {},
      parentContext,
    );
    const keepSpan = customTracer.startSpan(
      "gen_ai.keep_this",
      {},
      parentContext,
    );

    dropSpan.end();
    keepSpan.end();
    rootSpan.end();

    const spans = customMemoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    expect(spanNames).not.toContain("root");
    expect(spanNames).not.toContain("gen_ai.drop_this"); // dropped by custom filter
    expect(spanNames).toContain("gen_ai.keep_this"); // kept by default filter logic

    customProvider.shutdown();
  });

  it("should support custom filter that defers to default logic", () => {
    const customFilter = () => {
      return undefined; // Defer to default logic
    };

    const customMemoryExporter = new InMemorySpanExporter();
    const customFilterProcessor = new AISpanProcessor(
      new SimpleSpanProcessor(customMemoryExporter),
      customFilter,
    );
    const customProvider = createTracerProvider(BasicTracerProvider, [
      customFilterProcessor,
    ]);
    const customTracer = customProvider.getTracer("custom_test_tracer");

    const rootSpan = customTracer.startSpan("root");

    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    const llmSpan = customTracer.startSpan(
      "gen_ai.completion",
      {},
      parentContext,
    );
    const regularSpan = customTracer.startSpan(
      "regular_operation",
      {},
      parentContext,
    );

    llmSpan.end();
    regularSpan.end();
    rootSpan.end();

    const spans = customMemoryExporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    expect(spanNames).not.toContain("root");
    expect(spanNames).toContain("gen_ai.completion"); // kept by default filter logic
    expect(spanNames).not.toContain("regular_operation"); // dropped by default logic

    customProvider.shutdown();
  });

  describe("cross-version span filtering", () => {
    it.each([
      // Root spans (no parent) - should be filtered out unless AI/custom
      {
        name: "v1 root span",
        spanName: "v1-root-span",
        parentSpanContext: undefined,
        parentSpanId: undefined,
        attributes: {},
        expected: false,
        reason: "root spans are filtered out unless AI/custom",
      },
      {
        name: "v2 root span",
        spanName: "v2-root-span",
        parentSpanContext: undefined,
        parentSpanId: undefined,
        attributes: {},
        expected: false,
        reason: "root spans are filtered out unless AI/custom",
      },

      // Child spans without AI prefixes - should be dropped
      {
        name: "v1 child span (no AI prefix)",
        spanName: "database.query",
        parentSpanContext: undefined,
        parentSpanId: "parent-123",
        attributes: {},
        expected: false,
        reason: "child spans without AI prefixes are dropped",
      },
      {
        name: "v2 child span (no AI prefix)",
        spanName: "http.request",
        parentSpanContext: { spanId: "parent-456", traceId: "trace-789" },
        parentSpanId: undefined,
        attributes: {},
        expected: false,
        reason: "child spans without AI prefixes are dropped",
      },
      {
        name: "mixed child span (no AI prefix)",
        spanName: "regular.operation",
        parentSpanContext: { spanId: "parent-mixed", traceId: "trace-mixed" },
        parentSpanId: "parent-mixed-id",
        attributes: {},
        expected: false,
        reason: "child spans without AI prefixes are dropped",
      },

      // Child spans with AI prefixes - should be kept
      {
        name: "v1 child span with gen_ai prefix",
        spanName: "gen_ai.completion",
        parentSpanContext: undefined,
        parentSpanId: "parent-123",
        attributes: {},
        expected: true,
        reason: "child spans with AI prefixes are kept",
      },
      {
        name: "v2 child span with llm prefix",
        spanName: "llm.generate",
        parentSpanContext: { spanId: "parent-456", traceId: "trace-789" },
        parentSpanId: undefined,
        attributes: {},
        expected: true,
        reason: "child spans with AI prefixes are kept",
      },
      {
        name: "v1 child span with braintrust prefix",
        spanName: "braintrust.eval",
        parentSpanContext: undefined,
        parentSpanId: "parent-123",
        attributes: {},
        expected: true,
        reason: "child spans with AI prefixes are kept",
      },
      {
        name: "v2 child span with ai prefix",
        spanName: "ai.model_call",
        parentSpanContext: { spanId: "parent-456", traceId: "trace-789" },
        parentSpanId: undefined,
        attributes: {},
        expected: true,
        reason: "child spans with AI prefixes are kept",
      },
      {
        name: "mixed child span with traceloop prefix",
        spanName: "traceloop.agent",
        parentSpanContext: { spanId: "parent-mixed", traceId: "trace-mixed" },
        parentSpanId: "parent-mixed-id",
        attributes: {},
        expected: true,
        reason: "child spans with AI prefixes are kept",
      },

      // Child spans with AI attribute prefixes - should be kept
      {
        name: "v1 child span with gen_ai attribute",
        spanName: "some.operation",
        parentSpanContext: undefined,
        parentSpanId: "parent-123",
        attributes: { "gen_ai.model": "gpt-4" },
        expected: true,
        reason: "child spans with AI attribute prefixes are kept",
      },
      {
        name: "v2 child span with llm attribute",
        spanName: "some.operation",
        parentSpanContext: { spanId: "parent-456", traceId: "trace-789" },
        parentSpanId: undefined,
        attributes: { "llm.temperature": 0.7 },
        expected: true,
        reason: "child spans with AI attribute prefixes are kept",
      },
    ])(
      "should filter spans correctly across OTel versions: $name",
      ({
        spanName,
        parentSpanContext,
        parentSpanId,
        attributes,
        expected,
        reason,
      }) => {
        const filterProcessor = new AISpanProcessor({} as any);

        const mockSpan = {
          name: spanName,
          attributes,
          parentSpanContext,
          parentSpanId,
          spanContext: () => ({
            spanId: "test-span-id",
            traceId: "test-trace-id",
          }),
          kind: 0,
          startTime: [Date.now(), 0],
          endTime: [Date.now(), 0],
          status: { code: 0 },
          ended: true,
          duration: [0, 1000000],
          events: [],
          links: [],
          resource: {} as any,
          instrumentationLibrary: {} as any,
          instrumentationScope: {} as any,
          droppedAttributesCount: 0,
          droppedEventsCount: 0,
          droppedLinksCount: 0,
        } as unknown as ReadableSpan;

        const result = (filterProcessor as any).shouldKeepFilteredSpan(
          mockSpan,
        );

        expect(result).toBe(expected);
      },
    );
  });
});

describe("BraintrustSpanProcessor", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  it("should create BraintrustSpanProcessor with API key from environment", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    expect(() => {
      new BraintrustSpanProcessor();
    }).not.toThrow();
  });

  it("should create BraintrustSpanProcessor with API key from options", () => {
    expect(() => {
      new BraintrustSpanProcessor({
        apiKey: "test-api-key",
      });
    }).not.toThrow();
  });

  it("should reject forceFlush when no API key is provided", async () => {
    delete process.env.BRAINTRUST_API_KEY;

    await withEmptyBraintrustEnvFile(async () => {
      const processor = new BraintrustSpanProcessor();
      await expect(processor.forceFlush()).rejects.toThrow(
        "Braintrust API key is required",
      );
    });
  });

  it("should create BraintrustSpanProcessor with API key from .env.braintrust", async () => {
    delete process.env.BRAINTRUST_API_KEY;
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "braintrust-otel-env-"));
    try {
      await writeFile(
        path.join(tempDir, ".env.braintrust"),
        "BRAINTRUST_API_KEY=file-api-key\n",
      );
      process.chdir(tempDir);

      const processor = new BraintrustSpanProcessor();
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("should use default API URL when not provided", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const processor = new BraintrustSpanProcessor();
    expect(processor).toBeDefined();
  });

  it("should use custom API URL when provided", () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: "test-api-key",
      apiUrl: "https://custom.api.url",
    });
    expect(processor).toBeDefined();
  });

  it("primes OTEL bootstrap auth when the exporter initializes", async () => {
    const exporter = new BraintrustExporter({
      apiKey: "test-api-key",
      apiUrl: "https://custom.api.url",
    });

    await exporter.forceFlush();

    // @ts-expect-error internal OTEL bootstrap helper added by the login-burst fix
    expect(_exportsForTestingOnly.getOtelBootstrapAuthForTests()).toEqual({
      apiKey: "test-api-key",
      apiUrl: "https://custom.api.url/",
    });
  });

  it("initializes without the OTEL bootstrap auth helper on older braintrust versions", async () => {
    vi.resetModules();
    vi.doMock("braintrust", async () => {
      const actual =
        await vi.importActual<typeof import("braintrust")>("braintrust");
      const { _internalSetOtelBootstrapAuth: _unused, ...compatExports } =
        actual;
      return compatExports;
    });

    try {
      const compatModule = await import(
        /* @vite-ignore */ `./otel.ts?compat=${Date.now()}`
      );
      const exporter = new compatModule.BraintrustExporter({
        apiKey: "test-api-key",
        apiUrl: "https://custom.api.url",
      });

      await expect(exporter.forceFlush()).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("braintrust");
      vi.resetModules();
    }
  });

  it("should support custom headers", () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: "test-api-key",
      headers: {
        "X-Custom-Header": "custom-value",
      },
    });
    expect(processor).toBeDefined();
  });

  it("should support custom filter function", () => {
    const customFilter = (span: ReadableSpan) => {
      return span.name.includes("important");
    };

    const processor = new BraintrustSpanProcessor({
      apiKey: "test-api-key",
      customFilter,
    });
    expect(processor).toBeDefined();
  });

  it("should support parent option", () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: "test-api-key",
      parent: "project_name:otel_examples",
    });
    expect(processor).toBeDefined();
  });

  it("should use BRAINTRUST_PARENT environment variable", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";
    process.env.BRAINTRUST_PARENT = "project_name:env_examples";

    const processor = new BraintrustSpanProcessor();
    expect(processor).toBeDefined();
  });

  it("should use BRAINTRUST_API_URL environment variable", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";
    process.env.BRAINTRUST_API_URL = "https://custom.env.url";

    const processor = new BraintrustSpanProcessor();
    expect(processor).toBeDefined();
  });

  it("should prioritize options over environment variables", () => {
    process.env.BRAINTRUST_API_KEY = "env-api-key";
    process.env.BRAINTRUST_PARENT = "env-parent";
    process.env.BRAINTRUST_API_URL = "https://env.url";

    const processor = new BraintrustSpanProcessor({
      apiKey: "option-api-key",
      parent: "option-parent",
      apiUrl: "https://option.url",
    });
    expect(processor).toBeDefined();
  });

  it("should disable filtering by default", () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: "test-api-key",
    });
    expect(processor).toBeDefined();
  });

  it("should enable filtering when filterAISpans is true", () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: "test-api-key",
      filterAISpans: true,
    });
    expect(processor).toBeDefined();
  });

  it("should disable filtering when filterAISpans is false", () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: "test-api-key",
      filterAISpans: false,
    });
    expect(processor).toBeDefined();
  });

  it("should implement SpanProcessor interface", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const processor = new BraintrustSpanProcessor();

    expect(typeof processor.onStart).toBe("function");
    expect(typeof processor.onEnd).toBe("function");
    expect(typeof processor.shutdown).toBe("function");
    expect(typeof processor.forceFlush).toBe("function");
  });

  it("should forward span lifecycle methods to AISpanProcessor", async () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const processor = new BraintrustSpanProcessor();

    // Create a mock span
    const mockSpan = {
      spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
      end: vi.fn(),
      setAttributes: vi.fn(),
      name: "test-span",
      attributes: {},
      parentSpanContext: undefined,
    } as any;

    // Test onStart
    expect(() => {
      processor.onStart(mockSpan, context.active());
    }).not.toThrow();

    // Test onEnd
    expect(() => {
      processor.onEnd(mockSpan);
    }).not.toThrow();

    // Test shutdown and forceFlush
    await expect(processor.shutdown()).resolves.toBeUndefined();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });

  it("should use default parent when none is provided", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";
    delete process.env.BRAINTRUST_PARENT;

    const consoleSpy = vi.spyOn(console, "info");

    const processor = new BraintrustSpanProcessor();

    expect(processor).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      "No parent specified, using default: project_name:default-otel-project. " +
        "Configure with BRAINTRUST_PARENT environment variable or parent parameter.",
    );

    consoleSpy.mockRestore();
  });

  it("should not use default parent when BRAINTRUST_PARENT is set", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";
    process.env.BRAINTRUST_PARENT = "my-project:my-experiment";

    const consoleSpy = vi.spyOn(console, "info");

    const processor = new BraintrustSpanProcessor();

    expect(processor).toBeDefined();
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("should not use default parent when parent option is provided", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";
    delete process.env.BRAINTRUST_PARENT;

    const consoleSpy = vi.spyOn(console, "info");

    const processor = new BraintrustSpanProcessor({
      parent: "option-project:option-experiment",
    });

    expect(processor).toBeDefined();
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("BraintrustExporter", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  it("should create BraintrustExporter with API key from environment", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    expect(() => {
      new BraintrustExporter();
    }).not.toThrow();
  });

  it("should create BraintrustExporter with API key from options", () => {
    expect(() => {
      new BraintrustExporter({
        apiKey: "test-api-key",
      });
    }).not.toThrow();
  });

  it("should reject forceFlush when no API key is provided", async () => {
    delete process.env.BRAINTRUST_API_KEY;

    await withEmptyBraintrustEnvFile(async () => {
      const exporter = new BraintrustExporter();
      await expect(exporter.forceFlush()).rejects.toThrow(
        "Braintrust API key is required",
      );
    });
  });

  it("should use same options as BraintrustSpanProcessor", () => {
    const options = {
      apiKey: "test-api-key",
      apiUrl: "https://custom.api.url",
      parent: "project_name:test",
      filterAISpans: true,
      customFilter: (span: ReadableSpan) => span.name.includes("important"),
      headers: { "X-Custom": "value" },
    };

    expect(() => {
      new BraintrustExporter(options);
    }).not.toThrow();
  });

  it("should implement exporter interface", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();

    expect(typeof exporter.export).toBe("function");
    expect(typeof exporter.shutdown).toBe("function");
    expect(typeof exporter.forceFlush).toBe("function");
  });

  it("should export spans successfully", async () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();
    const mockSpans = [
      {
        name: "test-span",
        spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
        attributes: {},
        parentSpanContext: undefined,
      },
    ] as unknown as ReadableSpan[];

    return new Promise<void>((resolve, reject) => {
      exporter.export(mockSpans, (result) => {
        try {
          expect(result.code).toBe(0); // SUCCESS
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  it("should handle export errors gracefully", async () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();

    // Mock the processor to throw an error
    (exporter as any).processor = {
      onEnd: vi.fn().mockImplementation(() => {
        throw new Error("Test error");
      }),
      forceFlush: vi.fn(),
      shutdown: vi.fn(),
    };

    const mockSpans = [
      {
        name: "test-span",
        spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
        attributes: {},
        parentSpanContext: undefined,
      },
    ] as unknown as ReadableSpan[];

    return new Promise<void>((resolve, reject) => {
      exporter.export(mockSpans, (result) => {
        try {
          expect(result.code).toBe(1); // FAILURE
          expect(result.error).toBeDefined();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  it("should handle forceFlush errors gracefully", async () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();

    // Mock the processor to have forceFlush fail
    (exporter as any).processor = {
      onEnd: vi.fn(),
      forceFlush: vi.fn().mockRejectedValue(new Error("Flush error")),
      shutdown: vi.fn(),
    };

    const mockSpans = [
      {
        name: "test-span",
        spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
        attributes: {},
        parentSpanContext: undefined,
      },
    ] as unknown as ReadableSpan[];

    return new Promise<void>((resolve, reject) => {
      exporter.export(mockSpans, (result) => {
        try {
          expect(result.code).toBe(1); // FAILURE
          expect(result.error).toBeDefined();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  it("should forward shutdown to processor", async () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();
    const shutdownSpy = vi.spyOn((exporter as any).processor, "shutdown");

    await exporter.shutdown();

    expect(shutdownSpy).toHaveBeenCalled();
  });

  it("should forward forceFlush to processor", async () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();
    const flushSpy = vi.spyOn((exporter as any).processor, "forceFlush");

    await exporter.forceFlush();

    expect(flushSpy).toHaveBeenCalled();
  });

  it("should process multiple spans", async () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();
    const onEndSpy = vi.spyOn((exporter as any).processor, "onEnd");

    const mockSpans = [
      {
        name: "test-span-1",
        spanContext: () => ({ traceId: "test-trace", spanId: "test-span-1" }),
        attributes: {},
        parentSpanContext: undefined,
      },
      {
        name: "test-span-2",
        spanContext: () => ({ traceId: "test-trace", spanId: "test-span-2" }),
        attributes: {},
        parentSpanContext: undefined,
      },
    ] as unknown as ReadableSpan[];

    return new Promise<void>((resolve, reject) => {
      exporter.export(mockSpans, (result) => {
        try {
          expect(result.code).toBe(0); // SUCCESS
          expect(onEndSpy).toHaveBeenCalledTimes(2);
          expect(onEndSpy).toHaveBeenCalledWith(mockSpans[0]);
          expect(onEndSpy).toHaveBeenCalledWith(mockSpans[1]);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  it("should support filtering options", () => {
    const exporter = new BraintrustExporter({
      apiKey: "test-api-key",
      filterAISpans: true,
      customFilter: (span: ReadableSpan) => span.name.includes("important"),
    });

    expect(exporter).toBeDefined();
  });

  it("should support all configuration options", () => {
    process.env.BRAINTRUST_API_KEY = "env-key";
    process.env.BRAINTRUST_PARENT = "env-parent";
    process.env.BRAINTRUST_API_URL = "https://env.url";

    const exporter = new BraintrustExporter({
      apiKey: "option-key",
      parent: "option-parent",
      apiUrl: "https://option.url",
      filterAISpans: false,
      headers: { "X-Custom": "value" },
    });

    expect(exporter).toBeDefined();
  });

  it("should use default parent when none is provided", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";
    delete process.env.BRAINTRUST_PARENT;

    const consoleSpy = vi.spyOn(console, "info");

    const exporter = new BraintrustExporter();

    expect(exporter).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      "No parent specified, using default: project_name:default-otel-project. " +
        "Configure with BRAINTRUST_PARENT environment variable or parent parameter.",
    );

    consoleSpy.mockRestore();
  });

  it("exporter handles spans with common v1/v2 attributes", () => {
    process.env.BRAINTRUST_API_KEY = "test-api-key";

    const exporter = new BraintrustExporter();
    const processor = (exporter as any).processor;
    const batchProcessor = (processor as any).processor;
    const baseExporter = (batchProcessor as any)._exporter;

    const mockExport = vi.fn();
    baseExporter.export = mockExport;

    const testSpan = {
      name: "gen_ai.completion",
      spanContext: () => ({ traceId: "trace-123", spanId: "span-456" }),
      parentSpanId: "parent-789",
      instrumentationLibrary: { name: "openai", version: "1.0.0" },
      resource: {
        attributes: {
          "service.name": "test-service",
        },
      },
    } as any;

    baseExporter.export([testSpan], () => {});
    expect(mockExport).toHaveBeenCalledOnce();
    const [exportedSpans] = mockExport.mock.calls[0];

    expect(exportedSpans).toHaveLength(1);
    const exportedSpan = exportedSpans[0];

    // Check attributes that exist in both v1 and v2
    expect(exportedSpan.name).toBe("gen_ai.completion");
    expect(exportedSpan.spanContext).toBeTypeOf("function");
    expect(exportedSpan.spanContext()).toEqual({
      traceId: "trace-123",
      spanId: "span-456",
    });
    expect(exportedSpan.instrumentationLibrary).toEqual({
      name: "openai",
      version: "1.0.0",
    });
    expect(exportedSpan.resource.attributes).toEqual({
      "service.name": "test-service",
    });
  });
});

describe("otel namespace helpers", () => {
  let provider: BasicTracerProvider;
  let tracer: Tracer;

  beforeEach(() => {
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    tracer = trace.getTracer("test-tracer");

    // Set up W3C propagators for header parsing tests
    const compositePropagator = new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    });
    propagation.setGlobalPropagator(compositePropagator);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  describe("addParentToBaggage", () => {
    it("should add braintrust.parent to baggage", () => {
      const parent = "project_name:test:span_id:abc123:row_id:xyz789";
      const ctx = addParentToBaggage(parent);

      const baggage = propagation.getBaggage(ctx);
      expect(baggage?.getEntry("braintrust.parent")?.value).toBe(parent);
    });

    it("should use provided context", () => {
      const parent = "project_name:test:span_id:abc123:row_id:xyz789";
      const initialCtx = context.active();
      const resultCtx = addParentToBaggage(parent, initialCtx);

      const baggage = propagation.getBaggage(resultCtx);
      expect(baggage?.getEntry("braintrust.parent")?.value).toBe(parent);
    });
  });

  describe("addSpanParentToBaggage", () => {
    it("should extract braintrust.parent from span attribute and add to baggage", () => {
      const span = tracer.startSpan("test-span");
      const parent = "project_name:test:span_id:abc123:row_id:xyz789";
      span.setAttribute("braintrust.parent", parent);

      const ctx = addSpanParentToBaggage(span);
      expect(ctx).toBeDefined();

      const baggage = propagation.getBaggage(ctx!);
      expect(baggage?.getEntry("braintrust.parent")?.value).toBe(parent);

      span.end();
    });

    it("should return undefined when span has no braintrust.parent attribute", () => {
      const span = tracer.startSpan("test-span");

      const ctx = addSpanParentToBaggage(span);
      expect(ctx).toBeUndefined();

      span.end();
    });

    it("should use provided context", () => {
      const span = tracer.startSpan("test-span");
      const parent = "project_name:test:span_id:abc123:row_id:xyz789";
      span.setAttribute("braintrust.parent", parent);

      const initialCtx = context.active();
      const ctx = addSpanParentToBaggage(span, initialCtx);
      expect(ctx).toBeDefined();

      const baggage = propagation.getBaggage(ctx!);
      expect(baggage?.getEntry("braintrust.parent")?.value).toBe(parent);

      span.end();
    });
  });

  describe("parentFromHeaders", () => {
    describe("valid inputs", () => {
      it("should extract parent from headers with valid traceparent and braintrust.parent baggage", () => {
        const headers = {
          traceparent:
            "00-12345678901234567890123456789012-1234567890123456-01",
          baggage: "braintrust.parent=project_name:test",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeDefined();
        // Parent string is base64-encoded SpanComponentsV4
        expect(typeof parent).toBe("string");
        expect(parent!.length).toBeGreaterThan(0);
      });

      it("should extract parent with project_id", () => {
        const headers = {
          traceparent:
            "00-abcdef12345678901234567890123456-fedcba9876543210-01",
          baggage: "braintrust.parent=project_id:my-project-id",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeDefined();
        expect(typeof parent).toBe("string");
        expect(parent!.length).toBeGreaterThan(0);
      });

      it("should extract parent with experiment_id", () => {
        const headers = {
          traceparent:
            "00-11111111111111111111111111111111-2222222222222222-01",
          baggage: "braintrust.parent=experiment_id:my-experiment-id",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeDefined();
        expect(typeof parent).toBe("string");
        expect(parent!.length).toBeGreaterThan(0);
      });
    });

    describe("invalid inputs", () => {
      it("should return undefined when traceparent is missing", () => {
        const consoleSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        const headers = {
          baggage: "braintrust.parent=project_name:test",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeUndefined();
        expect(consoleSpy).toHaveBeenCalledWith(
          "parentFromHeaders: No valid span context in headers",
        );

        consoleSpy.mockRestore();
      });

      it("should return undefined when baggage is missing", () => {
        const consoleSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        const headers = {
          traceparent:
            "00-12345678901234567890123456789012-1234567890123456-01",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeUndefined();
        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain(
          "braintrust.parent not found",
        );

        consoleSpy.mockRestore();
      });

      it("should return undefined when braintrust.parent is missing from baggage", () => {
        const consoleSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        const headers = {
          traceparent:
            "00-12345678901234567890123456789012-1234567890123456-01",
          baggage: "foo=bar,baz=qux",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeUndefined();
        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain(
          "braintrust.parent not found",
        );

        consoleSpy.mockRestore();
      });

      it("should return undefined when traceparent format is invalid", () => {
        const consoleSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        const headers = {
          traceparent: "invalid-traceparent",
          baggage: "braintrust.parent=project_name:test",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeUndefined();
        expect(consoleSpy).toHaveBeenCalledWith(
          "parentFromHeaders: No valid span context in headers",
        );

        consoleSpy.mockRestore();
      });

      it("should return undefined when trace_id is all zeros", () => {
        const consoleSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        const headers = {
          traceparent:
            "00-00000000000000000000000000000000-1234567890123456-01",
          baggage: "braintrust.parent=project_name:test",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeUndefined();
        // OTEL's extract() validates and rejects invalid trace_id
        expect(consoleSpy).toHaveBeenCalledWith(
          "parentFromHeaders: No valid span context in headers",
        );

        consoleSpy.mockRestore();
      });

      it("should return undefined when span_id is all zeros", () => {
        const consoleSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        const headers = {
          traceparent:
            "00-12345678901234567890123456789012-0000000000000000-01",
          baggage: "braintrust.parent=project_name:test",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeUndefined();
        // OTEL's extract() validates and rejects invalid span_id
        expect(consoleSpy).toHaveBeenCalledWith(
          "parentFromHeaders: No valid span context in headers",
        );

        consoleSpy.mockRestore();
      });

      it("should return undefined when braintrust.parent format is invalid", () => {
        const consoleSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        const headers = {
          traceparent:
            "00-12345678901234567890123456789012-1234567890123456-01",
          baggage: "braintrust.parent=invalid",
        };

        const parent = parentFromHeaders(headers);
        expect(parent).toBeUndefined();
        // Should reach our validation if span context is valid, otherwise OTEL rejects it
        expect(consoleSpy).toHaveBeenCalled();

        consoleSpy.mockRestore();
      });
    });
  });
});

describe("Otel Compat tests Integration", () => {
  beforeEach(async () => {
    setupOtelCompat();

    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
    _exportsForTestingOnly.setInitialTestState();
    _exportsForTestingOnly.resetIdGenStateForTests();
  });

  afterEach(() => {
    resetOtelCompat();

    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
    _exportsForTestingOnly.resetIdGenStateForTests();
  });

  test("UUID generator should share span_id as root_span_id for backwards compatibility", async () => {
    // Ensure UUID generator is used (default behavior)
    resetOtelCompat();

    const testLogger = initLogger({
      projectName: "test-uuid-integration",
      projectId: "test-project-id",
    });

    const span = testLogger.startSpan({ name: "test-uuid-span" });

    // UUID generators should share span_id as root_span_id for backwards compatibility
    expect(span.spanId).toBe(span.rootSpanId);

    // Verify UUID format (36 characters with dashes)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(span.spanId).toMatch(uuidRegex);
    expect(span.rootSpanId).toMatch(uuidRegex);

    span.end();
  });

  test("OTEL generator should not share span_id as root_span_id", async () => {
    const testLogger = initLogger({
      projectName: "test-otel-integration",
      projectId: "test-project-id",
    });

    const span = testLogger.startSpan({ name: "test-otel-span" });

    // OTEL generators should not share span_id as root_span_id
    expect(span.spanId).not.toBe(span.rootSpanId);

    // Verify OTEL hex format
    expect(span.spanId.length).toBe(16); // 8 bytes = 16 hex characters
    expect(span.rootSpanId.length).toBe(32); // 16 bytes = 32 hex characters
    expect(/^[0-9a-f]{16}$/.test(span.spanId)).toBe(true);
    expect(/^[0-9a-f]{32}$/.test(span.rootSpanId)).toBe(true);

    span.end();
  });

  test("parent-child relationships work with UUID generators", async () => {
    resetOtelCompat();

    const testLogger = initLogger({
      projectName: "test-uuid-parent-child",
      projectId: "test-project-id",
    });

    const parentSpan = testLogger.startSpan({ name: "uuid-parent" });

    // Parent should have span_id === root_span_id
    expect(parentSpan.spanId).toBe(parentSpan.rootSpanId);

    const childSpan = parentSpan.startSpan({ name: "uuid-child" });

    // Child should inherit parent's root_span_id
    expect(childSpan.rootSpanId).toBe(parentSpan.rootSpanId);

    // Child should have parent in spanParents
    expect(childSpan.spanParents).toContain(parentSpan.spanId);

    // Child should have its own span_id (different from parent)
    expect(childSpan.spanId).not.toBe(parentSpan.spanId);

    parentSpan.end();
    childSpan.end();
  });

  test("parent-child relationships work with OTEL generators", async () => {
    const testLogger = initLogger({
      projectName: "test-otel-parent-child",
      projectId: "test-project-id",
    });

    const parentSpan = testLogger.startSpan({ name: "otel-parent" });

    // Parent should have span_id !== root_span_id for OTEL
    expect(parentSpan.spanId).not.toBe(parentSpan.rootSpanId);

    const childSpan = parentSpan.startSpan({ name: "otel-child" });

    // Child should inherit parent's root_span_id
    expect(childSpan.rootSpanId).toBe(parentSpan.rootSpanId);

    // Child should have parent in spanParents
    expect(childSpan.spanParents).toContain(parentSpan.spanId);

    // Child should have its own span_id (different from parent)
    expect(childSpan.spanId).not.toBe(parentSpan.spanId);

    // All IDs should be proper hex format
    expect(/^[0-9a-f]{16}$/.test(parentSpan.spanId)).toBe(true);
    expect(/^[0-9a-f]{32}$/.test(parentSpan.rootSpanId)).toBe(true);
    expect(/^[0-9a-f]{16}$/.test(childSpan.spanId)).toBe(true);
    expect(/^[0-9a-f]{32}$/.test(childSpan.rootSpanId)).toBe(true);

    parentSpan.end();
    childSpan.end();
  });

  test("environment variable switching works correctly", async () => {
    // Test default (UUID)
    resetOtelCompat();

    const uuidLogger = initLogger({
      projectName: "test-env-uuid",
      projectId: "test-project-id",
    });

    const uuidSpan = uuidLogger.startSpan({ name: "uuid-test" });
    expect(uuidSpan.spanId).toBe(uuidSpan.rootSpanId);
    expect(uuidSpan.spanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    uuidSpan.end();

    // Switch to OTEL
    setupOtelCompat();
    _exportsForTestingOnly.resetIdGenStateForTests();

    const otelLogger = initLogger({
      projectName: "test-env-otel",
      projectId: "test-project-id",
    });

    const otelSpan = otelLogger.startSpan({ name: "otel-test" });
    expect(otelSpan.spanId).not.toBe(otelSpan.rootSpanId);
    expect(otelSpan.spanId.length).toBe(16);
    expect(otelSpan.rootSpanId.length).toBe(32);
    otelSpan.end();

    // Switch back to UUID
    resetOtelCompat();
    _exportsForTestingOnly.resetIdGenStateForTests();

    const uuidLogger2 = initLogger({
      projectName: "test-env-uuid2",
      apiKey: "test-key",
    });

    const uuidSpan2 = uuidLogger2.startSpan({ name: "uuid-test2" });
    expect(uuidSpan2.spanId).toBe(uuidSpan2.rootSpanId);
    expect(uuidSpan2.spanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    uuidSpan2.end();
  });

  test("case insensitive environment variable", async () => {
    // Test uppercase

    const logger1 = initLogger({
      projectName: "test-case-upper",
      apiKey: "test-key",
    });

    const span1 = logger1.startSpan({ name: "test" });
    expect(span1.spanId).not.toBe(span1.rootSpanId); // Should be OTEL
    span1.end();

    // Test mixed case
    setupOtelCompat();
    _exportsForTestingOnly.resetIdGenStateForTests();

    const logger2 = initLogger({
      projectName: "test-case-mixed",
      apiKey: "test-key",
    });

    const span2 = logger2.startSpan({ name: "test" });
    expect(span2.spanId).not.toBe(span2.rootSpanId); // Should be OTEL
    span2.end();
  });
});

describe("export() format selection based on if otel is initialized", () => {
  beforeEach(async () => {
    setupOtelCompat();

    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
    _exportsForTestingOnly.resetIdGenStateForTests();
  });

  afterEach(() => {
    resetOtelCompat();

    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
    _exportsForTestingOnly.resetIdGenStateForTests();
  });

  test("uses SpanComponentsV3 when otel is not initialized", async () => {
    resetOtelCompat();

    const testLogger = initLogger({
      projectName: "test-export-v3",
      projectId: "test-project-id",
    });
    const span = testLogger.startSpan({ name: "test-span" });

    const exported = await span.export();
    expect(typeof exported).toBe("string");
    expect(exported.length).toBeGreaterThan(0);

    // Verify version byte is 3
    expect(getExportVersion(exported)).toBe(3);

    // The exported string should be parseable by both V3 and V4 (V4 can read V3)
    const v3Components = SpanComponentsV3.fromStr(exported);
    expect(v3Components.data.row_id).toBe(span.id);
    expect(v3Components.data.span_id).toBe(span.spanId);
    expect(v3Components.data.root_span_id).toBe(span.rootSpanId);

    // V4 should also be able to read V3 format
    const v4Components = SpanComponentsV4.fromStr(exported);
    expect(v4Components.data.row_id).toBe(span.id);

    span.end();
  });

  test("uses SpanComponentsV4 when otel is initialized", async () => {
    const testLogger = initLogger({
      projectName: "test-export-v4",
      apiKey: "test-key",
    });
    const span = testLogger.startSpan({ name: "test-span-v4" });

    const exported = await span.export();
    expect(typeof exported).toBe("string");
    expect(exported.length).toBeGreaterThan(0);

    // Verify version byte is 4
    expect(getExportVersion(exported)).toBe(4);

    // The exported string should be parseable by V4
    const v4Components = SpanComponentsV4.fromStr(exported);
    expect(v4Components.data.row_id).toBe(span.id);
    expect(v4Components.data.span_id).toBe(span.spanId);
    expect(v4Components.data.root_span_id).toBe(span.rootSpanId);

    span.end();
  });

  test("Logger.export() uses correct format based on env var", async () => {
    // Test V3
    resetOtelCompat();

    const loggerV3 = initLogger({
      projectName: "test-logger-export-v3",
      projectId: "test-project-id",
    });
    const exportedV3 = await loggerV3.export();
    expect(typeof exportedV3).toBe("string");

    const v3Parsed = SpanComponentsV3.fromStr(exportedV3);
    expect(v3Parsed.data.object_type).toBeDefined();

    // Test V4
    setupOtelCompat();
    const loggerV4 = initLogger({
      projectName: "test-logger-export-v4",
      apiKey: "test-key",
    });
    const exportedV4 = await loggerV4.export();
    expect(typeof exportedV4).toBe("string");

    const v4Parsed = SpanComponentsV4.fromStr(exportedV4);
    expect(v4Parsed.data.object_type).toBeDefined();
  });

  test("exported V4 span can be used as parent", async () => {
    const testLogger = initLogger({
      projectName: "test-v4-parent",
      apiKey: "test-key",
    });

    const parentSpan = testLogger.startSpan({ name: "parent-span-v4" });
    const exported = await parentSpan.export();
    parentSpan.end();

    // Should be able to use V4 exported string as parent
    const childSpan = testLogger.startSpan({
      name: "child-span-v4",
      parent: exported,
    });

    expect(childSpan.rootSpanId).toBe(parentSpan.rootSpanId);
    childSpan.end();
  });

  test("V4 format uses hex IDs (not UUIDs) when otel is initialized", async () => {
    _exportsForTestingOnly.resetIdGenStateForTests();

    const testLogger = initLogger({
      projectName: "test-hex-ids",
      apiKey: "test-key",
    });

    const span = testLogger.startSpan({ name: "test-span-hex" });

    // Verify the span has hex IDs (not UUIDs)
    expect(span.spanId.length).toBe(16); // 16 hex chars = 8 bytes
    expect(span.rootSpanId.length).toBe(32); // 32 hex chars = 16 bytes
    expect(/^[0-9a-f]{16}$/.test(span.spanId)).toBe(true);
    expect(/^[0-9a-f]{32}$/.test(span.rootSpanId)).toBe(true);

    // Verify these are NOT UUIDs (no dashes)
    expect(span.spanId).not.toContain("-");
    expect(span.rootSpanId).not.toContain("-");

    // Export the span
    const exported = await span.export();

    // Parse the exported data with V4
    const parsed = SpanComponentsV4.fromStr(exported);

    // Verify the parsed data has the same hex IDs
    expect(parsed.data.span_id).toBe(span.spanId);
    expect(parsed.data.root_span_id).toBe(span.rootSpanId);

    // V4 should efficiently encode hex IDs in binary format
    // The exported string should be shorter than V3 would produce with hex IDs
    // (V4 uses 8 bytes for span_id, 16 bytes for root_span_id in binary)
    const rawBytes = base64ToUint8Array(exported);

    // Check that version byte is 4
    expect(rawBytes[0]).toBe(4);

    span.end();
  });

  test("V3 format uses UUIDs when otel is not initialized", async () => {
    resetOtelCompat();

    _exportsForTestingOnly.resetIdGenStateForTests();

    const testLogger = initLogger({
      projectName: "test-uuid-ids",
      projectId: "test-project-id",
    });

    const span = testLogger.startSpan({ name: "test-span-uuid" });

    // Verify the span has UUID format (with dashes)
    expect(span.spanId.length).toBe(36); // UUID format
    expect(span.spanId).toContain("-");
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(span.spanId).toMatch(uuidRegex);

    // Export the span
    const exported = await span.export();

    // Parse the exported data with V3
    const parsed = SpanComponentsV3.fromStr(exported);

    // Verify the parsed data has the same UUID
    expect(parsed.data.span_id).toBe(span.spanId);

    // V3 uses UUID compression in binary format
    const rawBytes = base64ToUint8Array(exported);

    // Check that version byte is 3
    expect(rawBytes[0]).toBe(3);

    span.end();
  });
});
