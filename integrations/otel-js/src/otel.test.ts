/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { readFileSync } from "node:fs";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  test,
} from "vite-plus/test";
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
  BraintrustSpanProcessor,
  addSpanParentToBaggage,
  addParentToBaggage,
  parentFromHeaders,
  isRootSpan,
} from "./otel";
import { initLogger } from "braintrust";
import { SpanComponentsV3, SpanComponentsV4 } from "../../../js/util";
import { _exportsForTestingOnly } from "../../../js/src/logger/testing";
import {
  base64ToUint8Array,
  getExportVersion,
  createTracerProvider,
} from "../tests/utils";
import { setupOtelCompat, resetOtelCompat } from "./";

const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "../package.json"), "utf8"),
) as { version: string };

async function withBraintrustEnvFile<T>(
  content: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(tmpdir(), "braintrust-otel-env-"));
  try {
    await writeFile(path.join(tempDir, ".env.braintrust"), content);
    process.chdir(tempDir);
    return await fn();
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { force: true, recursive: true });
  }
}

function restoreEnvironment(snapshot: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in snapshot)) delete process.env[name];
  }
  Object.assign(process.env, snapshot);
}

describe("BraintrustSpanProcessor filtering", () => {
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let filterProcessor: BraintrustSpanProcessor<ReadableSpan>;
  let tracer: Tracer;
  let baseProcessor: SimpleSpanProcessor;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();

    // Create processor with our filtering logic
    baseProcessor = new SimpleSpanProcessor(memoryExporter);
    filterProcessor = new BraintrustSpanProcessor({
      processor: baseProcessor,
      filterAISpans: true,
    });

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

  it("should ignore Braintrust system attributes when filtering AI spans", async () => {
    const rootSpan = tracer.startSpan("root");

    const parentContext = trace.setSpanContext(
      context.active(),
      rootSpan.spanContext(),
    );
    const systemAttrSpan = tracer.startSpan(
      "some.operation",
      {
        attributes: {
          "braintrust.context_json": JSON.stringify({
            span_origin: { name: "braintrust.sdk.javascript" },
          }),
          "braintrust.parent": "project_name:test",
        },
      },
      parentContext,
    );

    systemAttrSpan.end();
    rootSpan.end();

    await provider.forceFlush();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans.find((s) => s.name === "some.operation")).toBeUndefined();
  });

  it("should support custom filter that keeps root spans using isRootSpan", () => {
    const customFilter = (span: ReadableSpan) => {
      return isRootSpan(span) ? true : undefined;
    };

    const customMemoryExporter = new InMemorySpanExporter();
    const customFilterProcessor = new BraintrustSpanProcessor({
      processor: new SimpleSpanProcessor(customMemoryExporter),
      filterAISpans: true,
      customFilter,
    });
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
    const customFilterProcessor = new BraintrustSpanProcessor({
      processor: new SimpleSpanProcessor(customMemoryExporter),
      filterAISpans: true,
      customFilter,
    });
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
    const customFilterProcessor = new BraintrustSpanProcessor({
      processor: new SimpleSpanProcessor(customMemoryExporter),
      filterAISpans: true,
      customFilter,
    });
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
    const customFilterProcessor = new BraintrustSpanProcessor({
      processor: new SimpleSpanProcessor(customMemoryExporter),
      filterAISpans: true,
      customFilter,
    });
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
    const customFilterProcessor = new BraintrustSpanProcessor({
      processor: new SimpleSpanProcessor(customMemoryExporter),
      filterAISpans: true,
      customFilter,
    });
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
        const onEnd = vi.fn();
        const filterProcessor = new BraintrustSpanProcessor({
          processor: {
            onEnd,
            onStart() {},
            async forceFlush() {},
            async shutdown() {},
          },
          filterAISpans: true,
        });

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

        filterProcessor.onEnd(mockSpan);
        expect(onEnd).toHaveBeenCalledTimes(expected ? 1 : 0);
        void filterProcessor.shutdown();
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
    restoreEnvironment(originalEnv);
    vi.restoreAllMocks();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  it("should merge span origin with context_json set after span start", () => {
    let endedSpan: ReadableSpan | undefined;
    const innerProcessor = {
      onStart: vi.fn(),
      onEnd: vi.fn((span: ReadableSpan) => {
        endedSpan = span;
      }),
      shutdown: vi.fn(async () => undefined),
      forceFlush: vi.fn(async () => undefined),
    };

    const processor = new BraintrustSpanProcessor({
      processor: innerProcessor as any,
    });

    const mockSpan = {
      spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
      setAttributes: vi.fn(),
      name: "late-context",
      attributes: {
        "braintrust.context_json": JSON.stringify({
          metadata: { source: "late-attribute" },
        }),
      },
      parentSpanContext: undefined,
    } as any;

    processor.onStart(mockSpan, context.active());
    processor.onEnd(mockSpan);

    expect(endedSpan).toBeDefined();
    const contextJson = endedSpan?.attributes["braintrust.context_json"];
    expect(typeof contextJson).toBe("string");
    const parsed = JSON.parse(contextJson as string);
    expect(parsed.metadata.source).toBe("late-attribute");
    expect(parsed.span_origin.name).toBe("braintrust.sdk.javascript");
    expect(parsed.span_origin.version).toBe(packageJson.version);
    expect(parsed.span_origin.instrumentation.name).toBe("braintrust-otel-js");
  });

  it("should preserve explicit environment name without type", () => {
    process.env.BRAINTRUST_ENVIRONMENT_NAME = "staging";
    delete process.env.BRAINTRUST_ENVIRONMENT_TYPE;

    let endedSpan: ReadableSpan | undefined;
    const innerProcessor = {
      onStart: vi.fn(),
      onEnd: vi.fn((span: ReadableSpan) => {
        endedSpan = span;
      }),
      shutdown: vi.fn(async () => undefined),
      forceFlush: vi.fn(async () => undefined),
    };

    const processor = new BraintrustSpanProcessor({
      processor: innerProcessor as any,
    });

    const mockSpan = {
      spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
      setAttributes: vi.fn(),
      name: "environment-name-only",
      attributes: {},
      parentSpanContext: undefined,
    } as any;

    processor.onStart(mockSpan, context.active());
    processor.onEnd(mockSpan);

    const parsed = JSON.parse(
      endedSpan?.attributes["braintrust.context_json"] as string,
    );
    expect(parsed.span_origin.environment).toEqual({ name: "staging" });
  });

  it("should read explicit environment name from .env.braintrust", async () => {
    delete process.env.BRAINTRUST_ENVIRONMENT_NAME;
    delete process.env.BRAINTRUST_ENVIRONMENT_TYPE;

    await withBraintrustEnvFile(
      "BRAINTRUST_ENVIRONMENT_NAME=staging\n",
      async () => {
        let endedSpan: ReadableSpan | undefined;
        const innerProcessor = {
          onStart: vi.fn(),
          onEnd: vi.fn((span: ReadableSpan) => {
            endedSpan = span;
          }),
          shutdown: vi.fn(async () => undefined),
          forceFlush: vi.fn(async () => undefined),
        };

        const processor = new BraintrustSpanProcessor({
          processor: innerProcessor as any,
        });

        const mockSpan = {
          spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
          setAttributes: vi.fn(),
          name: "environment-from-file",
          attributes: {},
          parentSpanContext: undefined,
        } as any;

        processor.onStart(mockSpan, context.active());
        processor.onEnd(mockSpan);

        const parsed = JSON.parse(
          endedSpan?.attributes["braintrust.context_json"] as string,
        );
        expect(parsed.span_origin.environment).toEqual({ name: "staging" });
      },
    );
  });

  it("should preserve custom NODE_ENV values as environment names", () => {
    process.env.NODE_ENV = "preview";
    delete process.env.BRAINTRUST_ENVIRONMENT_NAME;
    delete process.env.BRAINTRUST_ENVIRONMENT_TYPE;

    let endedSpan: ReadableSpan | undefined;
    const innerProcessor = {
      onStart: vi.fn(),
      onEnd: vi.fn((span: ReadableSpan) => {
        endedSpan = span;
      }),
      shutdown: vi.fn(async () => undefined),
      forceFlush: vi.fn(async () => undefined),
    };

    const processor = new BraintrustSpanProcessor({
      processor: innerProcessor as any,
    });

    const mockSpan = {
      spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
      setAttributes: vi.fn(),
      name: "custom-node-env",
      attributes: {},
      parentSpanContext: undefined,
    } as any;

    processor.onStart(mockSpan, context.active());
    processor.onEnd(mockSpan);

    const parsed = JSON.parse(
      endedSpan?.attributes["braintrust.context_json"] as string,
    );
    expect(parsed.span_origin.environment).toEqual({ name: "preview" });
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
    it("returns the opaque W3C context", () => {
      const headers = {
        traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
        tracestate: "vendor=value",
        baggage: "braintrust.parent=project_name%3Atest",
      };
      expect(parentFromHeaders(headers)).toEqual(headers);
    });

    it("keeps a valid trace context without Braintrust baggage", () => {
      const headers = {
        traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
      };
      expect(parentFromHeaders(headers)).toEqual(headers);
    });

    it.each([
      `braintrust.parent=project_name%3Atest,extra=${"x".repeat(8192)}`,
      Array.from({ length: 181 }, (_, index) => `k${index}=v`).join(","),
      `braintrust.parent=project_name%3Atest,extra=${"é".repeat(4096)}`,
    ])(
      "keeps oversized baggage opaque without invoking the OTEL parser",
      (baggage) => {
        const extractSpy = vi.spyOn(propagation, "extract");
        try {
          const parent = parentFromHeaders({
            traceparent:
              "00-12345678901234567890123456789012-1234567890123456-01",
            baggage,
          });
          expect(parent?.traceparent).toBeDefined();
          expect(parent?.baggage).toBe(baggage);
          expect(extractSpy).not.toHaveBeenCalled();
        } finally {
          extractSpy.mockRestore();
        }
      },
    );

    it.each([
      {},
      { traceparent: "invalid-traceparent" },
      {
        traceparent: "00-00000000000000000000000000000000-1234567890123456-01",
      },
      {
        traceparent: "00-12345678901234567890123456789012-0000000000000000-01",
      },
    ])("returns undefined for an invalid traceparent", (headers) => {
      expect(
        parentFromHeaders(headers as Record<string, string>),
      ).toBeUndefined();
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
    // Legacy UUID mode (hex ids are the default now).
    resetOtelCompat();
    const prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
    process.env.BRAINTRUST_LEGACY_IDS = "true";
    _exportsForTestingOnly.resetIdGenStateForTests();

    try {
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
    } finally {
      if (prevLegacy === undefined) {
        delete process.env.BRAINTRUST_LEGACY_IDS;
      } else {
        process.env.BRAINTRUST_LEGACY_IDS = prevLegacy;
      }
      _exportsForTestingOnly.resetIdGenStateForTests();
    }
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
    const prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
    process.env.BRAINTRUST_LEGACY_IDS = "true";
    _exportsForTestingOnly.resetIdGenStateForTests();

    try {
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
    } finally {
      if (prevLegacy === undefined) {
        delete process.env.BRAINTRUST_LEGACY_IDS;
      } else {
        process.env.BRAINTRUST_LEGACY_IDS = prevLegacy;
      }
      _exportsForTestingOnly.resetIdGenStateForTests();
    }
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
    const prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    try {
      // Test legacy UUID mode.
      resetOtelCompat();
      process.env.BRAINTRUST_LEGACY_IDS = "true";
      _exportsForTestingOnly.resetIdGenStateForTests();

      const uuidLogger = initLogger({
        projectName: "test-env-uuid",
        projectId: "test-project-id",
      });

      const uuidSpan = uuidLogger.startSpan({ name: "uuid-test" });
      expect(uuidSpan.spanId).toBe(uuidSpan.rootSpanId);
      expect(uuidSpan.spanId).toMatch(uuidRegex);
      uuidSpan.end();

      // Switch to the default hex ID mode. OTEL compat only changes context
      // management now; it does not override the core ID generator.
      delete process.env.BRAINTRUST_LEGACY_IDS;
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

      // Switch back to legacy UUID.
      resetOtelCompat();
      process.env.BRAINTRUST_LEGACY_IDS = "true";
      _exportsForTestingOnly.resetIdGenStateForTests();

      const uuidLogger2 = initLogger({
        projectName: "test-env-uuid2",
        apiKey: "test-key",
      });

      const uuidSpan2 = uuidLogger2.startSpan({ name: "uuid-test2" });
      expect(uuidSpan2.spanId).toBe(uuidSpan2.rootSpanId);
      expect(uuidSpan2.spanId).toMatch(uuidRegex);
      uuidSpan2.end();
    } finally {
      if (prevLegacy === undefined) {
        delete process.env.BRAINTRUST_LEGACY_IDS;
      } else {
        process.env.BRAINTRUST_LEGACY_IDS = prevLegacy;
      }
      _exportsForTestingOnly.resetIdGenStateForTests();
    }
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

  test("uses SpanComponentsV3 in legacy mode when otel is not initialized", async () => {
    resetOtelCompat();
    const prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
    process.env.BRAINTRUST_LEGACY_IDS = "true";
    _exportsForTestingOnly.resetIdGenStateForTests();

    try {
      const testLogger = initLogger({
        projectName: "test-export-v3",
        projectId: "test-project-id",
      });
      const span = testLogger.startSpan({ name: "test-span" });

      const exported = await span.export();
      expect(typeof exported).toBe("string");
      expect(exported.length).toBeGreaterThan(0);

      // Verify version byte is 3 (legacy UUID mode -> V3 export)
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
    } finally {
      if (prevLegacy === undefined) {
        delete process.env.BRAINTRUST_LEGACY_IDS;
      } else {
        process.env.BRAINTRUST_LEGACY_IDS = prevLegacy;
      }
    }
  });

  test("uses SpanComponentsV4 by default when otel is not initialized", async () => {
    resetOtelCompat();
    _exportsForTestingOnly.resetIdGenStateForTests();

    const testLogger = initLogger({
      projectName: "test-export-v4-default",
      projectId: "test-project-id",
    });
    const span = testLogger.startSpan({ name: "test-span" });

    const exported = await span.export();
    // The core SDK now defaults to V4 (OTEL-compatible hex ids) even without
    // compat installed.
    expect(getExportVersion(exported)).toBe(4);

    const v4Components = SpanComponentsV4.fromStr(exported);
    expect(v4Components.data.row_id).toBe(span.id);
    expect(v4Components.data.span_id).toBe(span.spanId);
    expect(v4Components.data.root_span_id).toBe(span.rootSpanId);

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
    // Test V3 (legacy UUID mode)
    resetOtelCompat();
    const prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
    process.env.BRAINTRUST_LEGACY_IDS = "true";
    _exportsForTestingOnly.resetIdGenStateForTests();

    const loggerV3 = initLogger({
      projectName: "test-logger-export-v3",
      projectId: "test-project-id",
    });
    const exportedV3 = await loggerV3.export();
    expect(typeof exportedV3).toBe("string");

    const v3Parsed = SpanComponentsV3.fromStr(exportedV3);
    expect(v3Parsed.data.object_type).toBeDefined();

    if (prevLegacy === undefined) {
      delete process.env.BRAINTRUST_LEGACY_IDS;
    } else {
      process.env.BRAINTRUST_LEGACY_IDS = prevLegacy;
    }
    _exportsForTestingOnly.resetIdGenStateForTests();

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

  test("V3 format uses UUIDs in legacy mode when otel is not initialized", async () => {
    resetOtelCompat();
    const prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
    process.env.BRAINTRUST_LEGACY_IDS = "true";
    _exportsForTestingOnly.resetIdGenStateForTests();

    try {
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
    } finally {
      if (prevLegacy === undefined) {
        delete process.env.BRAINTRUST_LEGACY_IDS;
      } else {
        process.env.BRAINTRUST_LEGACY_IDS = prevLegacy;
      }
      _exportsForTestingOnly.resetIdGenStateForTests();
    }
  });
});
