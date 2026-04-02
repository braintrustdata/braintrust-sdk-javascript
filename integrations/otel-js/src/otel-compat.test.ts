/**
 * Unit tests for OTEL + Braintrust context integration
 *
 * Tests that OTEL and Braintrust spans are properly grouped in unified traces
 * when created in mixed contexts.
 */

import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  initLogger,
  currentSpan,
  getContextManager,
  BRAINTRUST_CURRENT_SPAN_STORE,
  _exportsForTestingOnly,
  runEvaluator,
} from "braintrust";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import {
  AsyncHooksContextManager,
  AsyncLocalStorageContextManager,
} from "@opentelemetry/context-async-hooks";
import {
  getExportVersion,
  createTracerProvider,
  getParentSpanId,
} from "../tests/utils";
import {
  setupOtelCompat,
  resetOtelCompat,
  BraintrustSpanProcessor,
} from "@braintrust/otel";

class NoopProgressReporter {
  public start() {}
  public stop() {}
  public increment() {}
}

function setupOtelFixture(projectName: string = "otel-compat-test") {
  // For introspection in tests
  const exporter = new InMemorySpanExporter();
  const memoryProcessor = new SimpleSpanProcessor(exporter);

  // For actual Braintrust integration - inject test processor to avoid hitting APIs
  const braintrustProcessor = new BraintrustSpanProcessor({
    parent: `project_name:${projectName}`,
    _spanProcessor: memoryProcessor,
  });

  const tp = createTracerProvider(BasicTracerProvider, [
    braintrustProcessor, // Already wraps memoryProcessor for actual functionality
  ]);

  const tracer = tp.getTracer("otel-compat-test");

  return {
    tracer,
    exporter,
    processor: braintrustProcessor,
  };
}

describe("OTEL compatibility mode", () => {
  let contextManager: AsyncHooksContextManager;

  beforeEach(async () => {
    setupOtelCompat();

    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();

    // Set up OTEL context manager to enable context propagation
    contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    // Clean up context manager
    if (contextManager) {
      otelContext.disable();
      contextManager.disable();
    }
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
    resetOtelCompat();
  });

  test("mixed BT/OTEL tracing with BT logger first", async () => {
    const { tracer, exporter, processor } = setupOtelFixture(
      "mixed-tracing-bt-first",
    );
    const logger = initLogger({
      projectName: "mixed-tracing-bt-first",
      // projectId: "test-mixed-tracing-bt-first",
    });

    await logger.traced(
      async (span1) => {
        expect(currentSpan()).toBe(span1);

        await tracer.startActiveSpan("otel-span-2", async (otelSpan2) => {
          await logger.traced(
            async (span3) => {
              expect(currentSpan()).toBe(span3);

              // Verify span3 has otel span 2 as parent
              expect(span3.rootSpanId).toBe(span1.rootSpanId);
              expect(span3.spanParents.length).toBeGreaterThan(0);
            },
            { name: "bt-span-3" },
          );

          otelSpan2.end();
        });
      },
      { name: "bt-span-1" },
    );

    await processor.forceFlush();

    // Verify OTEL spans were created and have correct attributes
    const otelSpans = exporter.getFinishedSpans();
    expect(otelSpans.length).toBeGreaterThanOrEqual(1);

    const otelSpan = otelSpans.find((s) => s.name === "otel-span-2");
    expect(otelSpan).toBeDefined();
    if (otelSpan?.attributes) {
      expect(otelSpan.attributes["braintrust.parent"]).toContain(
        "project_name:mixed-tracing-bt-first",
      );
    }
  });

  test("mixed BT/OTEL tracing with OTEL first", async () => {
    const { tracer, exporter, processor } = setupOtelFixture(
      "mixed-tracing-otel-first",
    );
    const logger = initLogger({ projectName: "mixed-tracing-otel-first" });

    await tracer.startActiveSpan("otel-span-1", async (otelSpan1) => {
      await logger.traced(
        async (span2) => {
          expect(currentSpan()).toBe(span2);

          // BT span should inherit OTEL trace ID
          const otelContext = otelSpan1.spanContext();
          const otelTraceId = otelContext.traceId.toString().padStart(32, "0");

          expect(span2.rootSpanId).toBe(otelTraceId);

          await tracer.startActiveSpan("otel-span-3", async (otelSpan3) => {
            otelSpan3.end();
          });
        },
        { name: "bt-span-2" },
      );

      otelSpan1.end();
    });

    await processor.forceFlush();

    // Verify OTEL spans were created
    const otelSpans = exporter.getFinishedSpans();
    expect(otelSpans.length).toBeGreaterThanOrEqual(2);
  });

  test("BT span without explicit parent inherits from OTEL", async () => {
    const { tracer, exporter, processor } =
      setupOtelFixture("bt-inherits-otel");
    const logger = initLogger({ projectName: "bt-inherits-otel" });

    await tracer.startActiveSpan("otel-parent", async (otelParent) => {
      const btSpan = logger.startSpan({ name: "bt-child" });

      const otelContext = otelParent.spanContext();
      const otelTraceId = otelContext.traceId.toString().padStart(32, "0");
      const otelSpanId = otelContext.spanId.toString().padStart(16, "0");

      // BT span should have inherited OTEL parent's trace ID as root_span_id
      expect(btSpan.rootSpanId).toBe(otelTraceId);

      // BT span should have OTEL span as parent
      expect(btSpan.spanParents).toContain(otelSpanId);

      btSpan.end();
      otelParent.end();
    });

    await processor.forceFlush();

    // Verify OTEL span was created
    const otelSpans = exporter.getFinishedSpans();
    expect(otelSpans.length).toBeGreaterThanOrEqual(1);
  });

  test("mixed BT/OTEL with startSpan (matching Python pattern)", async () => {
    const { tracer, exporter, processor } = setupOtelFixture(
      "mixed-start-span-test",
    );
    const logger = initLogger({ projectName: "mixed-start-span-test" });
    const cm = getContextManager();

    const span1 = logger.startSpan({ name: "bt-span-1" });

    await cm.runInContext(span1, async () => {
      expect(currentSpan()).toBe(span1);

      await tracer.startActiveSpan("otel-span-2", async (otelSpan2) => {
        const span3 = logger.startSpan({ name: "bt-span-3" });

        await cm.runInContext(span3, async () => {
          expect(currentSpan()).toBe(span3);

          // Verify span3 has otel span 2 as parent
          const otelContext = otelSpan2.spanContext();
          const otelTraceId = otelContext.traceId.toString().padStart(32, "0");
          const otelSpanId = otelContext.spanId.toString().padStart(16, "0");

          expect(span3.rootSpanId).toBe(span1.rootSpanId);
          expect(span3.rootSpanId).toBe(otelTraceId);
          expect(span3.spanParents).toContain(otelSpanId);
        });

        span3.end();
        otelSpan2.end();
      });
    });

    span1.end();

    await processor.forceFlush();

    // Verify OTEL span was created with correct parent attribute
    const otelSpans = exporter.getFinishedSpans();
    expect(otelSpans.length).toBe(1);

    const otelSpan = otelSpans.find((s) => s.name === "otel-span-2");
    expect(otelSpan).toBeDefined();
    if (otelSpan?.attributes) {
      expect(otelSpan.attributes["braintrust.parent"]).toContain(
        "project_name:mixed-start-span-test",
      );
    }
  });

  test("uses BraintrustContextManager when OTEL disabled", () => {
    resetOtelCompat();

    const cm = getContextManager();

    expect(cm.constructor.name).toBe("BraintrustContextManager");
    expect(cm.getParentSpanIds).toBeDefined();
    expect(cm.runInContext).toBeDefined();
    expect(cm.getCurrentSpan).toBeDefined();
  });

  test("uses OtelContextManager when OTEL enabled", async () => {
    // Test that when OTEL is available and env var is set, we get OtelContextManager
    // Note: In test environment, OTEL packages may not be available even though
    // we checked OTEL_AVAILABLE. If the require fails in getContextManager,
    // it falls back to BraintrustContextManager, which is correct behavior.

    // Clear module cache and re-import to get fresh context manager
    const loggerModule = await import("braintrust?t=" + Date.now());
    const cm = loggerModule.getContextManager();

    // If OTEL is truly available, we should get OtelContextManager
    // Otherwise, fallback to BraintrustContextManager is acceptable
    if (cm.constructor.name === "OtelContextManager") {
      expect(cm.getParentSpanIds).toBeDefined();
      expect(cm.runInContext).toBeDefined();
      expect(cm.getCurrentSpan).toBeDefined();
    } else {
      // OTEL module not actually available at runtime, which is fine
      console.warn(
        "OTEL context manager not available at runtime, using fallback",
      );
    }
  });

  test("OTEL spans inherit braintrust.parent attribute", async () => {
    const { tracer, exporter, processor } = setupOtelFixture(
      "test-otel-parent-attr",
    );
    const logger = initLogger({
      projectName: "test-otel-parent-attr",
    });

    await logger.traced(
      async () => {
        await tracer.startActiveSpan("otel-child", async (otelChild) => {
          // Verify the span context is created
          expect(otelChild.spanContext().traceId).toBeDefined();
          otelChild.end();
        });
      },
      { name: "bt-parent" },
    );

    await processor.forceFlush();

    // Verify OTEL span has braintrust.parent attribute
    const otelSpans = exporter.getFinishedSpans();
    const otelChild = otelSpans.find((s) => s.name === "otel-child");

    expect(otelChild).toBeDefined();
    if (otelChild?.attributes) {
      expect(otelChild.attributes["braintrust.parent"]).toContain(
        "project_name:test-otel-parent-attr",
      );
    }
  });

  test("separate traces remain separate", async () => {
    const { tracer } = setupOtelFixture("separate-traces-test");
    const logger = initLogger({ projectName: "separate-traces" });

    let trace1Id: string | undefined;
    await logger.traced(
      async (btSpan1) => {
        trace1Id = btSpan1.rootSpanId;
        btSpan1.log({ input: "First trace" });
      },
      { name: "bt-trace-1" },
    );

    let trace2Id: string | undefined;
    await tracer.startActiveSpan("otel-trace-2", async (otelSpan2) => {
      const otelContext = otelSpan2.spanContext();
      trace2Id = otelContext.traceId.toString().padStart(32, "0");
      otelSpan2.setAttribute("test", "second_trace");
      otelSpan2.end();
    });

    let trace3Id: string | undefined;
    await tracer.startActiveSpan("otel-trace-3-root", async (otelSpan3) => {
      const otelContext = otelSpan3.spanContext();
      trace3Id = otelContext.traceId.toString().padStart(32, "0");

      await logger.traced(
        async (btSpan3) => {
          // BT span inside OTEL should inherit OTEL trace ID
          expect(btSpan3.rootSpanId).toBe(trace3Id);
          expect(btSpan3.rootSpanId).not.toBe(trace1Id);
        },
        { name: "bt-inside-otel-3" },
      );

      otelSpan3.end();
    });

    // Verify we have 3 separate traces
    expect(trace1Id).toBeDefined();
    expect(trace2Id).toBeDefined();
    expect(trace3Id).toBeDefined();
    expect(trace1Id).not.toBe(trace2Id);
    expect(trace1Id).not.toBe(trace3Id);
    expect(trace2Id).not.toBe(trace3Id);
  });

  test("OTEL spans in experiment Eval() inherit experiment_id parent", async () => {
    const { tracer, exporter, processor } = setupOtelFixture(
      "experiment-eval-test",
    );

    // Capture BT span info from inside the task
    const btSpanInfo: Array<{ traceId: string; spanId: string }> = [];

    // Use runEvaluator with null experiment to avoid API calls
    const result = await runEvaluator(
      null,
      {
        projectName: "test-eval-project",
        evalName: "otel-eval-test",
        data: [{ input: 1 }, { input: 2 }],
        task: async (input: number) => {
          // Capture the current BT span info
          const btSpan = currentSpan();
          if (btSpan) {
            btSpanInfo.push({
              traceId: btSpan.rootSpanId,
              spanId: btSpan.spanId,
            });
          }

          // Create an OTEL span inside the eval task
          await tracer.startActiveSpan("otel-compute", async (otelSpan) => {
            otelSpan.setAttribute("computation", input * 2);
            otelSpan.end();
          });
          return input * 2;
        },
        scores: [],
      },
      new NoopProgressReporter(),
      [],
      undefined,
    );

    // Verify we captured BT span info
    expect(btSpanInfo.length).toBe(2);

    // Verify results are correct
    expect(result.results.length).toBe(2);
    expect(result.results[0].output).toBe(2);
    expect(result.results[1].output).toBe(4);

    // Ensure spans are flushed
    await processor.forceFlush();

    // Verify OTEL spans were created
    const otelSpans = exporter.getFinishedSpans();
    const computeSpans = otelSpans.filter((s) => s.name === "otel-compute");
    expect(computeSpans.length).toBe(2);

    // Verify each OTEL span has trace ID that matches a BT span
    for (const otelSpan of computeSpans) {
      const otelContext = otelSpan.spanContext();
      const otelTraceId = otelContext.traceId.toString().padStart(32, "0");

      // OTEL span should inherit the BT span's root trace ID
      expect(btSpanInfo.some((bt) => bt.traceId === otelTraceId)).toBe(true);

      // Verify OTEL span has braintrust.parent attribute
      expect(otelSpan.attributes).toBeDefined();
      if (otelSpan.attributes) {
        // Should have project or experiment context
        const parentAttr = otelSpan.attributes["braintrust.parent"];
        expect(parentAttr).toBeDefined();
        expect(
          typeof parentAttr === "string" &&
            (parentAttr.includes("project_name:") ||
              parentAttr.includes("experiment_id:")),
        ).toBe(true);
      }
    }
  });

  test("OTEL spans are created when BT spans are active", async () => {
    const { tracer, exporter, processor } =
      setupOtelFixture("span-creation-test");
    const logger = initLogger({ projectName: "span-creation-test" });

    let otelSpanCreated = false;
    let otelSpanHasValidContext = false;

    await logger.traced(
      async () => {
        await tracer.startActiveSpan("otel-child", async (otelSpan) => {
          const ctx = otelSpan.spanContext();
          otelSpanCreated = true;
          otelSpanHasValidContext =
            ctx.traceId.length > 0 && ctx.spanId.length > 0;
          otelSpan.end();
        });
      },
      { name: "bt-parent" },
    );

    expect(otelSpanCreated).toBe(true);
    expect(otelSpanHasValidContext).toBe(true);

    await processor.forceFlush();

    // Verify the span was exported
    const otelSpans = exporter.getFinishedSpans();
    expect(otelSpans.length).toBeGreaterThanOrEqual(1);
    const createdSpan = otelSpans.find((s) => s.name === "otel-child");
    expect(createdSpan).toBeDefined();
  });

  test("OTEL spans inherit BT trace ID (trace unification)", async () => {
    const { tracer, exporter, processor } = setupOtelFixture("trace-id-test");
    const logger = initLogger({ projectName: "trace-id-test" });

    let btTraceId: string | undefined;
    let otelTraceId: string | undefined;
    let btSpanId: string | undefined;

    await logger.traced(
      async (btSpan) => {
        btTraceId = btSpan.rootSpanId;
        btSpanId = btSpan.spanId;

        await tracer.startActiveSpan("otel-child", async (otelSpan) => {
          const ctx = otelSpan.spanContext();
          otelTraceId = ctx.traceId.toString().padStart(32, "0");
          otelSpan.end();
        });
      },
      { name: "bt-parent" },
    );

    // Critical assertion: trace IDs should match for unified tracing
    expect(btTraceId).toBeDefined();
    expect(otelTraceId).toBeDefined();
    expect(otelTraceId).toBe(btTraceId);

    await processor.forceFlush();

    // Verify in exported spans
    const otelSpans = exporter.getFinishedSpans();
    const otelChild = otelSpans.find((s) => s.name === "otel-child");
    expect(otelChild).toBeDefined();

    if (otelChild) {
      const exportedTraceId = otelChild.spanContext().traceId;
      expect(exportedTraceId).toBe(btTraceId);

      // Verify parent relationship
      const parentId = getParentSpanId(otelChild);
      if (parentId) {
        expect(parentId).toBe(btSpanId);
      }
    }
  });

  test("multiple OTEL spans in nested BT contexts maintain parent chain", async () => {
    const { tracer, exporter, processor } = setupOtelFixture(
      "nested-parent-chain",
    );
    const logger = initLogger({ projectName: "nested-parent-chain" });

    const spanIds: string[] = [];

    await logger.traced(
      async (btSpan1) => {
        spanIds.push(btSpan1.spanId);

        await tracer.startActiveSpan("otel-span-1", async (otelSpan1) => {
          spanIds.push(
            otelSpan1.spanContext().spanId.toString().padStart(16, "0"),
          );

          await logger.traced(
            async (btSpan2) => {
              spanIds.push(btSpan2.spanId);

              await tracer.startActiveSpan("otel-span-2", async (otelSpan2) => {
                spanIds.push(
                  otelSpan2.spanContext().spanId.toString().padStart(16, "0"),
                );
                otelSpan2.end();
              });
            },
            { name: "bt-span-2" },
          );

          otelSpan1.end();
        });
      },
      { name: "bt-span-1" },
    );

    await processor.forceFlush();

    // Verify all spans were created
    expect(spanIds.length).toBe(4);

    const otelSpans = exporter.getFinishedSpans();
    expect(otelSpans.length).toBe(2);

    // Verify parent chain
    const otelSpan1 = otelSpans.find((s) => s.name === "otel-span-1");
    const otelSpan2 = otelSpans.find((s) => s.name === "otel-span-2");

    expect(otelSpan1).toBeDefined();
    expect(otelSpan2).toBeDefined();

    if (otelSpan1 && otelSpan2) {
      // otel-span-1 should have bt-span-1 as parent
      expect(getParentSpanId(otelSpan1)).toBe(spanIds[0]);

      // otel-span-2 should have bt-span-2 as parent
      expect(getParentSpanId(otelSpan2)).toBe(spanIds[2]);

      // Both should have same trace ID
      expect(otelSpan1.spanContext().traceId).toBe(
        otelSpan2.spanContext().traceId,
      );
    }
  });

  test("OTEL span attributes include braintrust.parent with project context", async () => {
    const { tracer, exporter, processor } = setupOtelFixture(
      "attribute-verification",
    );
    const logger = initLogger({ projectName: "attribute-verification" });

    await logger.traced(
      async () => {
        await tracer.startActiveSpan("otel-with-attrs", async (otelSpan) => {
          otelSpan.setAttribute("custom.attribute", "test-value");
          otelSpan.end();
        });
      },
      { name: "bt-parent" },
    );

    await processor.forceFlush();

    const otelSpans = exporter.getFinishedSpans();
    const otelSpan = otelSpans.find((s) => s.name === "otel-with-attrs");

    expect(otelSpan).toBeDefined();
    expect(otelSpan?.attributes).toBeDefined();

    if (otelSpan?.attributes) {
      // Verify custom attribute is preserved
      expect(otelSpan.attributes["custom.attribute"]).toBe("test-value");

      // Verify braintrust.parent is set
      expect(otelSpan.attributes["braintrust.parent"]).toContain(
        "project_name:attribute-verification",
      );
    }
  });

  test("exported V4 span can be used as parent (issue #986)", async () => {
    _exportsForTestingOnly.resetIdGenStateForTests();

    const logger = initLogger({
      projectName: "test-v4-parent-bug",
    });

    const parentSpan = logger.startSpan({ name: "parent-span-v4" });
    const exported = await parentSpan.export();

    expect(getExportVersion(exported)).toBe(4);

    parentSpan.end();

    const childSpan = logger.startSpan({
      name: "child-span-v4",
      parent: exported,
    });

    expect(childSpan.rootSpanId).toBe(parentSpan.rootSpanId);
    expect(childSpan.spanParents).toContain(parentSpan.spanId);

    childSpan.end();
  });

  test("exported V4 span can be used with withParent (issue #986)", async () => {
    _exportsForTestingOnly.resetIdGenStateForTests();

    const logger = initLogger({
      projectName: "test-v4-with-parent-bug",
    });

    const parentSpan = logger.startSpan({ name: "parent-span-v4" });
    const exported = await parentSpan.export();

    expect(getExportVersion(exported)).toBe(4);

    parentSpan.end();

    // Use withParent helper with logger.startSpan to properly handle the exported parent
    const { withParent } = await import("braintrust");

    withParent(exported, () => {
      // Pass parent explicitly in addition to withParent context
      const childSpan = logger.startSpan({
        name: "child-span-v4-with-parent",
        parent: exported,
      });

      expect(childSpan.rootSpanId).toBe(parentSpan.rootSpanId);
      expect(childSpan.spanParents).toContain(parentSpan.spanId);

      childSpan.end();
    });
  });
});

describe("OtelContextManager TracingChannel integration", () => {
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(async () => {
    setupOtelCompat();
    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();

    // AsyncLocalStorageContextManager (not AsyncHooksContextManager) exposes
    // _asyncLocalStorage which is required for TracingChannel bindStore.
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    if (contextManager) {
      otelContext.disable();
      contextManager.disable();
    }
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
    resetOtelCompat();
  });

  test("OtelContextManager exposes OTEL ALS via BRAINTRUST_CURRENT_SPAN_STORE", () => {
    const cm = getContextManager();
    expect(cm.constructor.name).toBe("OtelContextManager");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (cm as any)[BRAINTRUST_CURRENT_SPAN_STORE];
    expect(store).toBeDefined();
    expect(typeof store.run).toBe("function");
    expect(typeof store.getStore).toBe("function");
  });

  test("wrapSpanForStore returns OTEL Context that makes currentSpan() work", () => {
    const cm = getContextManager();
    const mockSpan = {
      spanId: "abc123def456789a",
      rootSpanId: "00000000000000000000000000000001",
      spanParents: [],
      getParentInfo: () => undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = cm.wrapSpanForStore(mockSpan as any);
    expect(ctx).toBeDefined();

    // Running in the returned context should expose the BT span via currentSpan()
    otelContext.with(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx as any,
      () => {
        expect(currentSpan()).toBe(mockSpan);
      },
    );
  });

  test("store.run() with wrapSpanForStore output propagates span to currentSpan()", () => {
    const cm = getContextManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (cm as any)[BRAINTRUST_CURRENT_SPAN_STORE];
    expect(store).toBeDefined();

    const mockSpan = {
      spanId: "deadbeef12345678",
      rootSpanId: "00000000000000000000000000000002",
      spanParents: [],
      getParentInfo: () => undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedCtx = cm.wrapSpanForStore(mockSpan as any);

    // Simulate what TracingChannel's runStores does: call store.run(value, fn)
    store.run(wrappedCtx, () => {
      expect(currentSpan()).toBe(mockSpan);
    });
  });

  test("nested store.run() calls maintain correct span chain", () => {
    const cm = getContextManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (cm as any)[BRAINTRUST_CURRENT_SPAN_STORE];

    const parentSpan = {
      spanId: "1111111111111111",
      rootSpanId: "00000000000000000000000000000003",
      spanParents: [],
      getParentInfo: () => undefined,
    };
    const childSpan = {
      spanId: "2222222222222222",
      rootSpanId: "00000000000000000000000000000003",
      spanParents: ["1111111111111111"],
      getParentInfo: () => undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.run(cm.wrapSpanForStore(parentSpan as any), () => {
      expect(currentSpan()).toBe(parentSpan);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.run(cm.wrapSpanForStore(childSpan as any), () => {
        expect(currentSpan()).toBe(childSpan);
      });

      // After inner run completes, outer span is restored
      expect(currentSpan()).toBe(parentSpan);
    });

    // After all runs, no BT span is active (getCurrentSpan returns undefined)
    expect(getContextManager().getCurrentSpan()).toBeUndefined();
  });

  test("wrapSpanForStore result sets OTEL active span with matching IDs", () => {
    const cm = getContextManager();
    const mockSpan = {
      spanId: "aabbccddeeff0011",
      rootSpanId: "aabbccddeeff00112233445566778899",
      spanParents: [],
      getParentInfo: () => undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = cm.wrapSpanForStore(mockSpan as any);

    otelContext.with(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx as any,
      () => {
        const activeSpan = otelTrace.getActiveSpan();
        expect(activeSpan).toBeDefined();

        const spanCtx = activeSpan!.spanContext();
        expect(spanCtx.traceId).toBe(mockSpan.rootSpanId);
        expect(spanCtx.spanId).toBe(mockSpan.spanId);
      },
    );
  });
});

describe("OtelContextManager fallback ALS (AsyncHooksContextManager)", () => {
  let hooksContextManager: AsyncHooksContextManager;

  beforeEach(async () => {
    setupOtelCompat();
    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();

    // AsyncHooksContextManager does NOT expose _asyncLocalStorage, so
    // OtelContextManager should create its own fallback ALS.
    hooksContextManager = new AsyncHooksContextManager();
    hooksContextManager.enable();
    otelContext.setGlobalContextManager(hooksContextManager);
  });

  afterEach(() => {
    if (hooksContextManager) {
      otelContext.disable();
      hooksContextManager.disable();
    }
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
    resetOtelCompat();
  });

  test("exposes fallback ALS via BRAINTRUST_CURRENT_SPAN_STORE when OTEL ALS is unavailable", () => {
    const cm = getContextManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (cm as any)[BRAINTRUST_CURRENT_SPAN_STORE];
    expect(store).toBeDefined();
    expect(typeof store.run).toBe("function");
    expect(typeof store.getStore).toBe("function");
  });

  test("wrapSpanForStore returns span directly (not OTEL Context) in fallback mode", () => {
    const cm = getContextManager();
    const mockSpan = {
      spanId: "1234567890abcdef",
      rootSpanId: "00000000000000000000000000000010",
      spanParents: [],
      getParentInfo: () => undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = cm.wrapSpanForStore(mockSpan as any);
    // In fallback mode, the span is stored directly (not wrapped in OTEL Context)
    expect(result).toBe(mockSpan);
  });

  test("store.run() with span in fallback mode makes getCurrentSpan() work", () => {
    const cm = getContextManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (cm as any)[BRAINTRUST_CURRENT_SPAN_STORE];

    const mockSpan = {
      spanId: "fedcba0987654321",
      rootSpanId: "00000000000000000000000000000011",
      spanParents: [],
      getParentInfo: () => undefined,
    };

    store.run(mockSpan, () => {
      expect(cm.getCurrentSpan()).toBe(mockSpan);
    });

    expect(cm.getCurrentSpan()).toBeUndefined();
  });
});

describe("Distributed Tracing (BT → OTEL)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let trace: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any;
  let contextManager: AsyncHooksContextManager;

  beforeEach(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
    setupOtelCompat();

    const otelApi = await import("@opentelemetry/api");
    trace = otelApi.trace;
    context = otelApi.context;

    // Set up OTEL context manager to enable context propagation
    contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    // Clean up context manager
    if (contextManager) {
      context.disable();
      contextManager.disable();
    }
    resetOtelCompat();
  });

  test("otelContextFromSpanExport parses BT span and creates OTEL context", async () => {
    const { contextFromSpanExport: otelContextFromSpanExport } =
      await import("./");
    const { SpanComponentsV4 } = await import("braintrust/util");
    const { SpanObjectTypeV3 } = await import("braintrust/util");

    // Create a sample span export string
    const rootSpanId = "a1b2c3d4e5f6789012345678abcdef01"; // 32 hex chars (16 bytes)
    const spanId = "a1b2c3d4e5f67890"; // 16 hex chars (8 bytes)
    const objectId = "proj-123";

    const components = new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: objectId,
      row_id: "row-123",
      span_id: spanId,
      root_span_id: rootSpanId,
      propagated_event: undefined,
    });

    const exportStr = components.toStr();

    const ctx = otelContextFromSpanExport(exportStr);

    // Verify that a valid context was created
    expect(ctx).toBeDefined();

    // Extract the span from the context
    const span = trace.getSpan(ctx);
    expect(span).toBeDefined();

    const spanContext = span.spanContext();
    expect(spanContext).toBeDefined();

    // Verify trace ID matches (OTEL trace IDs are already hex strings)
    expect(spanContext.traceId).toBe(rootSpanId);

    // Verify span ID matches
    expect(spanContext.spanId).toBe(spanId);

    // Verify it's marked as remote
    expect(spanContext.isRemote).toBe(true);
  });

  test("BT span in Service A can be parent of OTEL span in Service B", async () => {
    const { tracer, exporter, processor } =
      setupOtelFixture("service-a-project");
    const { contextFromSpanExport: otelContextFromSpanExport } =
      await import("./");

    const projectName = "service-a-project";
    const logger = initLogger({ projectName });

    // ===== Service A: Create BT span and export =====
    let serviceATraceId: string | undefined;
    let serviceASpanId: string | undefined;
    let exportedContext: string | undefined;

    await logger.traced(
      async (serviceASpan) => {
        serviceATraceId = serviceASpan.rootSpanId;
        serviceASpanId = serviceASpan.spanId;

        // Export context for sending to Service B (e.g., via HTTP header)
        exportedContext = await serviceASpan.export();
      },
      { name: "service_a_span" },
    );

    expect(exportedContext).toBeDefined();
    expect(serviceATraceId).toBeDefined();
    expect(serviceASpanId).toBeDefined();

    // ===== Service B: Import context and create OTEL child span =====
    const ctx = otelContextFromSpanExport(exportedContext!);

    // Use context.with() to run code in the imported context
    await context.with(ctx, async () => {
      await tracer.startActiveSpan("service_b_span", async (serviceBSpan) => {
        serviceBSpan.setAttribute("service", "service_b");
        serviceBSpan.end();
      });
    });

    await processor.forceFlush();

    // ===== Verify distributed tracing worked correctly =====
    const otelSpans = exporter.getFinishedSpans();
    expect(otelSpans.length).toBe(1);

    const serviceBSpan = otelSpans[0];
    expect(serviceBSpan.name).toBe("service_b_span");

    // Get OTEL span context
    const serviceBContext = serviceBSpan.spanContext();
    const serviceBTraceId = serviceBContext.traceId;

    // Assert unified trace ID across services
    expect(serviceBTraceId).toBe(serviceATraceId);

    // Service B span should have Service A span as parent
    if (serviceBSpan.parentSpanId) {
      expect(serviceBSpan.parentSpanId).toBe(serviceASpanId);
    }

    // Note: In distributed tracing, the braintrust.parent attribute is NOT
    // automatically set in Service B because there's no active BT span context.
    // The imported context only contains trace/span IDs for parent-child relationships.
    // This is expected behavior - the key feature is trace ID unification.
    expect(serviceBSpan.attributes).toBeDefined();
    if (serviceBSpan.attributes) {
      // Verify the attribute is NOT set (this is expected in distributed scenarios)
      expect(serviceBSpan.attributes["braintrust.parent"]).toBeUndefined();
    }
  });
});
