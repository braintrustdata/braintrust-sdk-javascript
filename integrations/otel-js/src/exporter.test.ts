import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  diag,
  DiagLogLevel,
  TraceFlags,
  type DiagLogger,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { BraintrustSpanProcessor } from "./otel";
import { createTracerProvider } from "../tests/utils";
import { _exportsForTestingOnly } from "braintrust";

type OtlpTraceRequest = {
  resourceSpans?: Array<{
    scopeSpans?: Array<{
      scope?: {
        name?: string;
        version?: string;
      };
      spans?: Array<{
        name?: string;
        parentSpanId?: string;
      }>;
    }>;
  }>;
};

describe("BraintrustSpanProcessor - Real HTTP Exporter", () => {
  const TEST_API_KEY = "test-api-key-12345";
  const TEST_PARENT = "project_name:test-export-project";

  let testApiUrl: string;
  let server: Server;
  let failExports = false;
  let capturedRequests: Array<{
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/otel/v1/traces") {
        res.writeHead(404).end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        if (failExports) {
          res.writeHead(500).end("export failed");
          return;
        }

        capturedRequests.push({
          url: new URL(req.url ?? "/", testApiUrl).href,
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(", ") : (value ?? ""),
            ]),
          ),
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });

        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });

    testApiUrl = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(async () => {
    capturedRequests = [];
    failExports = false;
    await _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    diag.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  it("should send spans via HTTP to correct OTLP endpoint with proper headers", async () => {
    // Create processor WITHOUT _spanProcessor to test real exporter path
    const processor = new BraintrustSpanProcessor({
      apiKey: TEST_API_KEY,
      apiUrl: testApiUrl,
      parent: TEST_PARENT,
    });

    const provider = createTracerProvider(BasicTracerProvider, [processor]);
    const tracer = provider.getTracer("test-tracer");

    // Create a span
    const span = tracer.startSpan("test-span");
    span.setAttribute("test.attribute", "test-value");
    span.end();

    // Flush to trigger HTTP export
    await processor.forceFlush();
    await provider.shutdown();

    // Verify HTTP request was made
    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);

    const request = capturedRequests[0];

    // Verify URL
    expect(request.url).toBe(`${testApiUrl}/otel/v1/traces`);

    // Verify headers
    expect(request.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY}`);
    expect(request.headers["x-bt-parent"]).toBe(TEST_PARENT);
    expect(request.headers["content-type"]).toContain("application/json");

    // Verify body structure (OTLP format)
    expect(request.body).toHaveProperty("resourceSpans");
  });

  it("should work with filterAISpans enabled", async () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: TEST_API_KEY,
      apiUrl: testApiUrl,
      parent: TEST_PARENT,
      filterAISpans: true,
    });

    const provider = createTracerProvider(BasicTracerProvider, [processor]);
    const tracer = provider.getTracer("test-tracer");

    // Create root and AI spans
    const rootSpan = tracer.startSpan("root-operation");
    const aiSpan = tracer.startSpan("gen_ai.completion");
    aiSpan.end();
    rootSpan.end();

    await processor.forceFlush();
    await provider.shutdown();

    // Should still make HTTP request with filtered spans
    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    expect(capturedRequests[0].body).toHaveProperty("resourceSpans");
  });

  it("should export OTel 1.x-shaped spans through newer OTLP exporters", async () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: TEST_API_KEY,
      apiUrl: testApiUrl,
      parent: TEST_PARENT,
    });
    const parentSpanId = "3333333333333333";
    const v1Span = {
      name: "gen_ai.completion",
      spanContext: () => ({
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        traceFlags: TraceFlags.SAMPLED,
      }),
      parentSpanId,
      instrumentationLibrary: { name: "otel-v1-lib", version: "1.2.3" },
      kind: 0,
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 0 },
      attributes: {},
      events: [],
      links: [],
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
      resource: {
        attributes: {
          "service.name": "otel-v1-service",
        },
        asyncAttributesPending: false,
      },
    } as unknown as ReadableSpan;

    processor.onEnd(v1Span);
    await processor.forceFlush();
    await processor.shutdown();

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const body = capturedRequests[0].body as OtlpTraceRequest;
    const scopeSpan = body.resourceSpans?.[0]?.scopeSpans?.[0];
    const exportedSpan = scopeSpan?.spans?.[0];

    expect(scopeSpan?.scope).toEqual({
      name: "otel-v1-lib",
      version: "1.2.3",
    });
    expect(exportedSpan?.name).toBe("gen_ai.completion");
    expect(exportedSpan?.parentSpanId).toBe(parentSpanId);
    expect("instrumentationScope" in v1Span).toBe(false);
    expect("parentSpanContext" in v1Span).toBe(false);
  });

  it("should report export failures through OTel diagnostics", async () => {
    failExports = true;

    const diagErrors: unknown[][] = [];
    const testDiagLogger: DiagLogger = {
      error: (...args) => diagErrors.push(args),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    };
    diag.setLogger(testDiagLogger, {
      logLevel: DiagLogLevel.ERROR,
      suppressOverrideMessage: true,
    });

    const processor = new BraintrustSpanProcessor({
      apiKey: TEST_API_KEY,
      apiUrl: testApiUrl,
      parent: TEST_PARENT,
    });
    const provider = createTracerProvider(BasicTracerProvider, [processor]);
    const tracer = provider.getTracer("test-tracer");
    const span = tracer.startSpan("test-span");
    span.end();

    await expect(processor.forceFlush()).rejects.toThrow();
    await provider.shutdown().catch(() => undefined);

    expect(
      diagErrors.some(
        (args) =>
          args[0] === "@braintrust/otel" &&
          args[1] === "Braintrust OTLP span export failed",
      ),
    ).toBe(true);
  });
});
