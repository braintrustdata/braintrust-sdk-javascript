import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vite-plus/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { createTracerProvider } from "../tests/utils";
import { createTestProcessor } from "../tests/export-fixtures";
import { _exportsForTestingOnly } from "../../../js/src/logger/testing";

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
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  it("should send spans via HTTP to correct OTLP endpoint with proper headers", async () => {
    // Create processor WITHOUT _spanProcessor to test real exporter path
    const processor = createTestProcessor({
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
    const processor = createTestProcessor({
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

  it("should propagate transport failures through processor forceFlush", async () => {
    failExports = true;

    const processor = createTestProcessor({
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
  });
});
