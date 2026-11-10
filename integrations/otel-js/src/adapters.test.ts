import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  BraintrustExporter,
  BraintrustSpanProcessor,
  braintrustOtlpConfig,
  addParentToBaggage,
} from "./otel";
import { createTracerProvider } from "../tests/utils";
import { _internalGetGlobalState } from "../../../js/src/logger/core";
import type { ReadableSpan, ExportResult } from "./types";

async function realSpans() {
  const memory = new InMemorySpanExporter();
  const provider = createTracerProvider(BasicTracerProvider, [
    new SimpleSpanProcessor(memory),
  ]);
  provider.getTracer("adapters").startSpan("gen_ai.test").end();
  await provider.forceFlush();
  const spans = [...memory.getFinishedSpans()];
  await provider.shutdown();
  return spans;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OTLP configuration", () => {
  test("returns protocol configuration without choosing SDK classes or content type", () => {
    expect(
      braintrustOtlpConfig({
        apiKey: "test-key",
        parent: "project_name:test",
        apiUrl: "https://example.test/prefix",
        headers: {
          "x-custom": "value",
          authorization: "ignored",
          "X-BT-Parent": "ignored",
        },
      }),
    ).toEqual({
      url: "https://example.test/prefix/otel/v1/traces",
      headers: {
        Authorization: "Bearer test-key",
        "x-bt-parent": "project_name:test",
        "x-custom": "value",
      },
    });
  });

  test("uses environment defaults and gives explicit options precedence", () => {
    vi.stubEnv("BRAINTRUST_API_KEY", "env-key");
    vi.stubEnv("BRAINTRUST_PARENT", "project_name:env");
    vi.stubEnv("BRAINTRUST_API_URL", "https://example.test/");
    expect(braintrustOtlpConfig().headers.Authorization).toBe("Bearer env-key");
    expect(
      braintrustOtlpConfig({ apiKey: "explicit" }).headers.Authorization,
    ).toBe("Bearer explicit");
    expect(braintrustOtlpConfig().url).toBe(
      "https://example.test/otel/v1/traces",
    );
  });

  test("requires credentials and explicit routing without creating a default project", () => {
    expect(() =>
      braintrustOtlpConfig({ apiKey: "", parent: "project_name:test" }),
    ).toThrow("API key is required");
    expect(() => braintrustOtlpConfig({ apiKey: "test", parent: "" })).toThrow(
      "parent is required",
    );
  });
});

describe("exporter lifecycle", () => {
  test("forwards one complete batch and the original transport result", async () => {
    const spans = await realSpans();
    const result = { code: 1, error: new Error("transport failed") };
    const downstream = {
      export: vi.fn(
        (_spans: ReadableSpan[], callback: (result: ExportResult) => void) =>
          callback(result),
      ),
      shutdown: vi.fn(async () => {}),
      forceFlush: vi.fn(async () => {}),
    };
    const exporter = new BraintrustExporter({ exporter: downstream });
    const received = await new Promise((resolve) =>
      exporter.export(spans, resolve),
    );
    expect(received).toBe(result);
    expect(downstream.export).toHaveBeenCalledTimes(1);
    expect(downstream.export.mock.calls[0][0]).toHaveLength(1);
    expect(downstream.forceFlush).not.toHaveBeenCalled();
    expect(spans[0].attributes["braintrust.context_json"]).toBeUndefined();
    await exporter.shutdown();
  });

  test("reports synchronous transport errors once", async () => {
    const spans = await realSpans();
    const error = new Error("transport failed");
    const callback = vi.fn();
    const exporter = new BraintrustExporter({
      exporter: {
        export() {
          throw error;
        },
        async shutdown() {},
      },
    });
    exporter.export(spans, callback);
    await exporter.forceFlush();
    expect(callback).toHaveBeenCalledExactlyOnceWith({ code: 1, error });
    await exporter.shutdown();
  });

  test("flush and shutdown wait for in-flight exports and shutdown is idempotent", async () => {
    const spans = await realSpans();
    let finish!: (result: ExportResult) => void;
    const downstream = {
      export: vi.fn(
        (_spans: ReadableSpan[], callback: (result: ExportResult) => void) => {
          finish = callback;
        },
      ),
      shutdown: vi.fn(async () => {}),
      forceFlush: vi.fn(async () => {}),
    };
    const exporter = new BraintrustExporter({ exporter: downstream });
    const callback = vi.fn();
    exporter.export(spans, callback);
    await vi.waitFor(() => expect(downstream.export).toHaveBeenCalledTimes(1));
    const flushed = exporter.forceFlush();
    const shutdown = exporter.shutdown();
    expect(exporter.shutdown()).toBe(shutdown);
    expect(downstream.shutdown).not.toHaveBeenCalled();
    const rejected = vi.fn();
    exporter.export(spans, rejected);
    expect(rejected.mock.calls[0][0].code).toBe(1);
    finish({ code: 0 });
    await Promise.all([flushed, shutdown]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ code: 0 });
    expect(downstream.shutdown).toHaveBeenCalledTimes(1);
    expect(downstream.forceFlush).toHaveBeenCalledTimes(1);
  });

  test("completes empty batches without calling the transport", async () => {
    const downstream = { export: vi.fn(), async shutdown() {} };
    const exporter = new BraintrustExporter({ exporter: downstream });
    expect(
      await new Promise((resolve) => exporter.export([], resolve)),
    ).toEqual({ code: 0 });
    expect(downstream.export).not.toHaveBeenCalled();
    await exporter.shutdown();
  });
});

test("all active processors flush and shutdown removes only its own registration", async () => {
  const first = {
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const second = {
    ...first,
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const a = new BraintrustSpanProcessor({ processor: first });
  const b = new BraintrustSpanProcessor({ processor: second });
  try {
    await _internalGetGlobalState().flushOtel();
    expect(first.forceFlush).toHaveBeenCalledTimes(1);
    expect(second.forceFlush).toHaveBeenCalledTimes(1);
    await a.shutdown();
    await a.shutdown();
    await _internalGetGlobalState().flushOtel();
    expect(first.forceFlush).toHaveBeenCalledTimes(1);
    expect(second.forceFlush).toHaveBeenCalledTimes(2);
    expect(first.shutdown).toHaveBeenCalledTimes(1);
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
  }
});

test("routing follows the supplied parent context instead of the ambient context", async () => {
  const memory = new InMemorySpanExporter();
  const processor = new BraintrustSpanProcessor({
    processor: new SimpleSpanProcessor(memory),
  });
  const provider = createTracerProvider(BasicTracerProvider, [processor]);
  try {
    const tracer = provider.getTracer("routing");
    const parent = addParentToBaggage("project_name:explicit", ROOT_CONTEXT);
    const span = tracer.startSpan("child", {}, parent);
    span.end();
    await provider.forceFlush();
    expect(memory.getFinishedSpans()[0].attributes["braintrust.parent"]).toBe(
      "project_name:explicit",
    );
    expect(trace.getSpan(context.active())).toBeUndefined();
  } finally {
    await provider.shutdown();
  }
});
