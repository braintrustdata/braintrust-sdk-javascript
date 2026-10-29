import { _exportsForTestingOnly } from "../../../js/src/logger/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import vm from "node:vm";
import * as braintrust from "braintrust";
import { context, createTraceState, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SamplingDecision,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  setupOtelCompat,
  resetOtelCompat,
  BraintrustSpanProcessor,
  BraintrustExporter,
} from "./";
import { createTracerProvider } from "../tests/utils";

type Data = Record<string, any>;
const shared = globalThis as Record<string | symbol, any>;
const customizersKey = Symbol.for("braintrust.spanCustomizers");
const failureKey = Symbol.for("braintrust.spanCustomizerFailureLogged");
const require = createRequire(`${process.cwd()}/package.json`);

describe("OpenTelemetry span customizers at the HTTP boundary", () => {
  let server: Server;
  let apiUrl: string;
  let bodies: Data[];
  let headers: Data[];
  let retryRemaining = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        headers.push(req.headers);
        if (retryRemaining-- > 0) {
          res.writeHead(503, { "retry-after": "0" }).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    bodies = [];
    headers = [];
    retryRemaining = 0;
    delete shared[failureKey];
  });
  afterEach(() => {
    delete shared[customizersKey];
    delete shared[failureKey];
    resetOtelCompat();
    trace.disable();
    vi.restoreAllMocks();
  });

  function received(): Data[] {
    return bodies.flatMap((body) =>
      body.resourceSpans.flatMap((resource: Data) =>
        resource.scopeSpans.flatMap((scope: Data) => scope.spans),
      ),
    );
  }

  async function fixture(): Promise<ReadableSpan[]> {
    const memory = new InMemorySpanExporter();
    const provider = createTracerProvider(BasicTracerProvider, [
      new SimpleSpanProcessor(memory),
    ]);
    const tracer = provider.getTracer("PRIVATE-scope", "PRIVATE-version");
    const root = tracer.startSpan("PRIVATE-root", {
      attributes: {
        "braintrust.parent": "project_id:routed",
        "braintrust.input_json": '"PRIVATE-input"',
        "braintrust.context_json": '{"secret":"PRIVATE-context"}',
        values: ["PRIVATE-array"],
      },
    });
    const child = tracer.startSpan(
      "PRIVATE-child",
      {
        links: [
          {
            context: root.spanContext(),
            attributes: { secret: "PRIVATE-link" },
          },
        ],
      },
      trace.setSpan(context.active(), root),
    );
    root.addEvent("PRIVATE-event", { secret: "PRIVATE-event-attribute" });
    root.setStatus({ code: 2, message: "PRIVATE-status" });
    child.end();
    root.end();
    await provider.forceFlush();
    const spans = [...memory.getFinishedSpans()];
    await provider.shutdown();
    return spans;
  }

  async function send(spans: ReadableSpan[]): Promise<void> {
    const exporter = new BraintrustExporter({
      apiKey: "test",
      apiUrl,
      parent: "project_name:default",
    });
    try {
      await new Promise<void>((resolve, reject) =>
        exporter.export(spans, (result) =>
          result.code ? reject(result.error) : resolve(),
        ),
      );
    } finally {
      await exporter.shutdown();
    }
  }

  test("replacement snapshots remove content without changing live spans, identity, timing or routing", async () => {
    const spans = await fixture();
    const seen: Data[] = [];
    shared[customizersKey] = [
      {
        onSpanExport(data: Data) {
          expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
          expect(typeof data.spanContext).toBe("object");
          expect(
            JSON.parse(data.attributes["braintrust.context_json"]),
          ).toHaveProperty("span_origin");
          seen.push(structuredClone(data));
          data.spanContext.spanId = "aaaaaaaaaaaaaaaa";
          data.startTime[0] = 0;
          if (data.attributes.values) data.attributes.values[0] = "mutated";
          data.resource.attributes.secret = "mutated";
          data.instrumentationScope.name = "mutated";
          return {
            name: "redacted",
            attributes: {
              clean: true,
              "braintrust.parent": "project_id:wrong",
            },
          };
        },
      },
      {
        onSpanExport(data: Data) {
          expect(data.spanContext.spanId).not.toBe("aaaaaaaaaaaaaaaa");
          expect(data.events).toEqual([]);
          return data;
        },
      },
    ];
    await send(spans);
    expect(seen).toHaveLength(2);
    const output = received();
    expect(output).toHaveLength(2);
    for (let i = 0; i < spans.length; i++) {
      const original = spans[i];
      const exported = output.find(
        (entry) => entry.spanId === original.spanContext().spanId,
      )!;
      expect(exported.traceId).toBe(original.spanContext().traceId);
      expect(exported.name).toBe("redacted");
      expect(
        BigInt(exported.endTimeUnixNano) - BigInt(exported.startTimeUnixNano),
      ).toBe(
        BigInt(original.duration[0]) * 1_000_000_000n +
          BigInt(original.duration[1]),
      );
      expect(exported.events ?? []).toEqual([]);
      expect(exported.links ?? []).toEqual([]);
      expect(exported.status?.message).toBeUndefined();
      expect(original.name).toContain("PRIVATE");
      expect(original.resource.attributes.secret).toBeUndefined();
    }
    const root = output.find((entry) =>
      entry.attributes.some((attr: Data) => attr.key === "braintrust.parent"),
    )!;
    expect(root.attributes).toContainEqual({
      key: "braintrust.parent",
      value: { stringValue: "project_id:routed" },
    });
    expect(output.find((entry) => entry !== root)?.parentSpanId).toBe(
      root.spanId,
    );
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
    expect(JSON.stringify(bodies)).not.toContain("mutated");
    expect(headers[0]["x-bt-parent"]).toBe("project_name:default");
    expect(
      spans.find((span) => span.name === "PRIVATE-root")?.attributes.values,
    ).toEqual(["PRIVATE-array"]);
  });

  test.each([undefined, [], [{}]])(
    "keeps the no-hook path unchanged (%j)",
    async (customizers) => {
      shared[customizersKey] = customizers;
      await send(await fixture());
      expect(received().map((span) => span.name)).toEqual([
        "PRIVATE-child",
        "PRIVATE-root",
      ]);
      expect(JSON.stringify(bodies)).toContain("PRIVATE-event");
    },
  );

  test("redacts shared async resource attributes before export", async () => {
    const spans = await fixture();
    const resource = {
      attributes: {} as Record<string, string>,
      asyncAttributesPending: true,
      async waitForAsyncAttributes() {
        await Promise.resolve();
        resource.attributes = { secret: "PRIVATE-resource", clean: "kept" };
        resource.asyncAttributesPending = false;
      },
    };
    const hook = vi.fn((data: Data) => {
      expect(data.resource.attributes.secret).toBe("PRIVATE-resource");
      delete data.resource.attributes.secret;
      return { name: "redacted", resource: data.resource };
    });
    shared[customizersKey] = [{ onSpanExport: hook }];
    const pendingSpans = spans.map(
      (span) =>
        new Proxy(span, {
          get(target, key) {
            if (key === "resource") return resource;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    await send(pendingSpans);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(received().map((span) => span.name)).toEqual([
      "redacted",
      "redacted",
    ]);
    expect(bodies[0].resourceSpans).toHaveLength(1);
    expect(bodies[0].resourceSpans[0].resource.attributes).toEqual([
      { key: "clean", value: { stringValue: "kept" } },
    ]);
    expect(resource.attributes.secret).toBe("PRIVATE-resource");
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
  });

  test("accepts cross-realm and null-prototype replacements and serializes added events and links", async () => {
    const spans = await fixture();
    shared[customizersKey] = [
      {
        onSpanExport: () =>
          vm.runInNewContext(
            '({ name: "cross-realm", attributes: { clean: ["safe"] } })',
          ),
      },
      {
        onSpanExport(data: Data) {
          const result = Object.assign(Object.create(null), data);
          result.events = [
            { name: "safe-event", time: [1, 2], attributes: { clean: true } },
          ];
          result.links = [
            { context: data.spanContext, attributes: { clean: true } },
          ];
          return result;
        },
      },
    ];
    await send(spans);
    expect(received()).toHaveLength(2);
    expect(received()[0].events[0].name).toBe("safe-event");
    expect(received()[0].links[0].spanId).toBe(spans[0].spanContext().spanId);
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
  });

  test.each([
    [
      "throw",
      () => {
        throw new Error("PRIVATE-error");
      },
    ],
    ["undefined", () => undefined],
    ["null", () => null],
    ["promise", () => Promise.reject(new Error("PRIVATE-promise"))],
    ["array", () => []],
    ["class", () => new (class Result {})()],
    [
      "cyclic",
      (data: Data) => {
        data.attributes.cycle = data;
        return data;
      },
    ],
    [
      "nested attribute",
      (data: Data) => {
        data.attributes.bad = { private: true };
        return data;
      },
    ],
    [
      "event",
      (data: Data) => {
        data.events = [{ name: "PRIVATE", time: "bad" }];
        return data;
      },
    ],
    [
      "link",
      (data: Data) => {
        data.links = [{ context: {} }];
        return data;
      },
    ],
    [
      "status",
      (data: Data) => {
        data.status = { code: "bad", message: "PRIVATE" };
        return data;
      },
    ],
    [
      "resource",
      (data: Data) => {
        data.resource = { attributes: { bad: {} } };
        return data;
      },
    ],
    [
      "scope",
      (data: Data) => {
        data.instrumentationScope = { name: {} };
        return data;
      },
    ],
  ])(
    "fails closed for %s while exporting other records",
    async (_name, fail) => {
      const spans = await fixture();
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const subsequent = vi.fn((data: Data) => data);
      shared[customizersKey] = [
        {
          onSpanExport(data: Data) {
            if (data.name === "PRIVATE-root") return fail(data);
            return { name: "healthy" };
          },
        },
        { onSpanExport: subsequent },
      ];
      await send(spans);
      await send(spans);
      expect(subsequent).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("PRIVATE");
      const output = received();
      expect(output).toHaveLength(4);
      const stripped = output.filter((entry) => entry.name === "");
      expect(stripped).toHaveLength(2);
      const original = spans.find((span) => span.name === "PRIVATE-root")!;
      for (const span of stripped) {
        expect(span.spanId).toBe(original.spanContext().spanId);
        expect(span.traceId).toBe(original.spanContext().traceId);
        expect(
          BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano),
        ).toBe(
          BigInt(original.duration[0]) * 1_000_000_000n +
            BigInt(original.duration[1]),
        );
        expect(span.attributes).toEqual(
          expect.arrayContaining([
            {
              key: "braintrust.context_json",
              value: { stringValue: '{"customizer_error":true}' },
            },
            {
              key: "braintrust.parent",
              value: { stringValue: "project_id:routed" },
            },
          ]),
        );
        expect(span.attributes).toHaveLength(2);
        expect(span.events ?? []).toEqual([]);
        expect(span.links ?? []).toEqual([]);
        expect(span.status?.message).toBeUndefined();
      }
      expect(output.filter((entry) => entry.name === "healthy")).toHaveLength(
        2,
      );
      for (const body of bodies) {
        for (const resource of body.resourceSpans) {
          expect(resource.resource.attributes ?? []).toEqual([]);
          for (const scope of resource.scopeSpans) {
            expect(scope.scope.name ?? "").toBe("");
            expect(scope.scope.version).toBeUndefined();
          }
        }
      }
      expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
    },
  );

  test("filters before customization, enriches origin first, and never changes another consumer", async () => {
    const other = new InMemorySpanExporter();
    const hook = vi.fn((data: Data) => {
      expect(data.attributes["braintrust.context_json"]).toContain("sdk");
      return { name: "redacted" };
    });
    shared[customizersKey] = [{ onSpanExport: hook }];
    const processor = new BraintrustSpanProcessor({
      apiKey: "test",
      apiUrl,
      parent: "project_name:test",
      filterAISpans: true,
    });
    const provider = createTracerProvider(BasicTracerProvider, [
      processor,
      new SimpleSpanProcessor(other),
    ]);
    try {
      const tracer = provider.getTracer("consumer");
      tracer.startSpan("dropped").end();
      tracer.startSpan("gen_ai.PRIVATE").end();
      await provider.forceFlush();
      expect(hook).toHaveBeenCalledTimes(1);
      expect(received().map((span) => span.name)).toEqual(["redacted"]);
      expect(other.getFinishedSpans().map((span) => span.name)).toEqual([
        "dropped",
        "gen_ai.PRIVATE",
      ]);
    } finally {
      await provider.shutdown();
    }
  });

  test("composed processor/exporter invokes once and does not re-enrich stripped records", async () => {
    const hook = vi.fn(() => {
      throw new Error("PRIVATE");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    shared[customizersKey] = [{ onSpanExport: hook }];
    const exporter = new BraintrustExporter({
      apiKey: "test",
      apiUrl,
      parent: "project_name:test",
    });
    const processor = new BraintrustSpanProcessor({
      _spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const spans = await fixture();
    processor.onEnd(spans[0]);
    await processor.forceFlush();
    await processor.shutdown();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(received()).toHaveLength(1);
    expect(received()[0].attributes).toEqual([
      {
        key: "braintrust.context_json",
        value: { stringValue: '{"customizer_error":true}' },
      },
    ]);
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
  });

  test("HTTP retries reuse the stripped snapshot without rerunning hooks", async () => {
    retryRemaining = 1;
    const hook = vi.fn(() => {
      throw new Error("PRIVATE");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    shared[customizersKey] = [{ onSpanExport: hook }];
    const [span] = await fixture();
    await send([span]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
    expect(received()[0].attributes).toEqual([
      {
        key: "braintrust.context_json",
        value: { stringValue: '{"customizer_error":true}' },
      },
    ]);
  });

  test("compatibility mode customizes native logger/experiment and OTel roots and children", async () => {
    const processor = new BraintrustSpanProcessor({
      apiKey: "test",
      apiUrl,
      parent: "project_name:test",
    });
    const provider = createTracerProvider(BasicTracerProvider, [processor]);
    trace.setGlobalTracerProvider(provider);
    const hook = vi.fn((data: Data) =>
      "attributes" in data
        ? { name: "redacted", attributes: { clean: true } }
        : { output: "redacted" },
    );
    shared[customizersKey] = [{ onSpanExport: hook }];
    await _exportsForTestingOnly.simulateLoginForTests();
    const memory = _exportsForTestingOnly.useTestBackgroundLogger();
    setupOtelCompat();
    try {
      const logger = braintrust.initLogger({
        projectId: "test",
        projectName: "test",
      });
      const experiment = _exportsForTestingOnly.initTestExperiment(
        "experiment",
        "test",
      );
      for (const parent of [logger, experiment]) {
        const root = parent.startSpan({ name: "PRIVATE" });
        const child = root.startSpan({ name: "PRIVATE-child" });
        child.log({ input: "PRIVATE-input" });
        child.end();
        root.end();
      }
      const records = await memory.drain();
      expect(records).toHaveLength(4);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
      const tracer = provider.getTracer("compat");
      const root = tracer.startSpan("PRIVATE");
      tracer
        .startSpan("PRIVATE-child", {}, trace.setSpan(context.active(), root))
        .end();
      root.end();
      await provider.forceFlush();
      expect(
        hook.mock.calls.filter(([data]) => "attributes" in data),
      ).toHaveLength(2);
      // Native spans may produce several incremental records before merging.
      expect(
        hook.mock.calls.filter(([data]) => "id" in data).length,
      ).toBeGreaterThanOrEqual(4);
      expect(received()).toHaveLength(2);
      expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
    } finally {
      await provider.shutdown();
      _exportsForTestingOnly.clearTestBackgroundLogger();
      _exportsForTestingOnly.simulateLogoutForTests();
    }
  });

  test.each([true, false])(
    "shares once-only diagnostics across CJS native and ESM OTel exports (native first: %s)",
    async (nativeFirst) => {
      const bt = require("braintrust") as typeof braintrust;
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      shared[customizersKey] = [
        {
          onSpanExport() {
            throw new Error("PRIVATE");
          },
        },
      ];
      await _exportsForTestingOnly.simulateLoginForTests();
      const memory = _exportsForTestingOnly.useTestBackgroundLogger();
      const native = async () => {
        const span = bt
          .initLogger({ projectName: "native", projectId: "native" })
          .startSpan({ name: "PRIVATE" });
        span.log({ output: "PRIVATE" });
        span.end();
        const records = await memory.drain();
        expect(records[0]).toHaveProperty("context", {
          customizer_error: true,
        });
        expect(JSON.stringify(records)).not.toContain("PRIVATE");
      };
      try {
        const spans = await fixture();
        if (nativeFirst) await native();
        await send(spans);
        if (!nativeFirst) await native();
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(received()).toHaveLength(2);
        expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
      } finally {
        _exportsForTestingOnly.clearTestBackgroundLogger();
        _exportsForTestingOnly.simulateLogoutForTests();
      }
    },
  );
  test("standalone ESM registration configures the CJS OTel bundle before initialization", async () => {
    // A fresh process is necessary: this worker has initialized instrumentation.
    // The bootstrap's delayed imports intentionally test module loading order.
    const script = `
      import { configureInstrumentation } from "braintrust/instrumentation";
      import { createRequire } from "node:module";
      import { promisify } from "node:util";
      const require = createRequire(import.meta.url);
      let calls = 0;
      configureInstrumentation({ spanCustomizers: [{ onSpanExport(data) {
        calls++;
        return { name: "bootstrap-redacted" };
      } }] });
      const { BraintrustExporter, setupOtelCompat } = require("@braintrust/otel");
      setupOtelCompat();
      const exporter = new BraintrustExporter({
        apiKey: "test", apiUrl: ${JSON.stringify(apiUrl)}, parent: "project_name:bootstrap"
      });
      const span = {
        name: "PRIVATE", spanContext: () => ({ traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }),
        startTime: [1, 0], endTime: [2, 0], duration: [1, 0],
        attributes: {}, events: [], links: [], status: { code: 0 }, kind: 0,
        resource: { attributes: {} }, instrumentationScope: { name: "PRIVATE" },
        droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0
      };
      await promisify((done) => {
        exporter.export([span], result => done(
          result.code ? result.error ?? new Error("Export failed") : null
        ));
      })();
      await exporter.shutdown();
      if (calls !== 1) throw new Error("Expected one callback");
    `;
    await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: process.cwd() },
    );
    expect(received().map((span) => span.name)).toEqual(["bootstrap-redacted"]);
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
  });

  test("a never-resolving async resource cannot hang flush", async () => {
    const [span] = await fixture();
    const hook = vi.fn((data: Data) => data);
    shared[customizersKey] = [{ onSpanExport: hook }];
    const pendingSpan = new Proxy(span, {
      get(target, key) {
        if (key === "resource")
          return {
            attributes: {},
            asyncAttributesPending: true,
            waitForAsyncAttributes: () => new Promise<void>(() => {}),
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const processor = new BraintrustSpanProcessor({
      apiKey: "test",
      apiUrl,
      parent: "project_name:test",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      processor.onEnd(pendingSpan);
      const flushed = processor.forceFlush().then(
        () => "settled",
        () => "settled",
      );
      // BatchSpanProcessor's default export timeout bounds the wait.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await flushed).toBe("settled");
    } finally {
      vi.useRealTimers();
    }
    expect(hook).not.toHaveBeenCalled();
  });

  test("composed inner processors filter the uncustomized span", async () => {
    const hook = vi.fn((data: Data) => {
      delete data.attributes["gen_ai.PRIVATE"];
      return data;
    });
    shared[customizersKey] = [{ onSpanExport: hook }];
    const exporter = new BraintrustExporter({
      apiKey: "test",
      apiUrl,
      parent: "project_name:test",
      filterAISpans: true,
    });
    const processor = new BraintrustSpanProcessor({
      _spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const provider = createTracerProvider(BasicTracerProvider, [processor]);
    try {
      provider
        .getTracer("composed")
        .startSpan("ai-span", { attributes: { "gen_ai.PRIVATE": "value" } })
        .end();
      await provider.forceFlush();
    } finally {
      await provider.shutdown();
    }
    expect(hook).toHaveBeenCalledTimes(1);
    expect(received().map((span) => span.name)).toEqual(["ai-span"]);
    expect(JSON.stringify(bodies)).not.toContain("PRIVATE");
  });

  test.each([
    ["changed", false],
    ["stripped", true],
  ])(
    "trace state and remote flag are protocol identity (%s)",
    async (_name, fail) => {
      const [span] = await fixture();
      const withTraceState = new Proxy(span, {
        get(target, key) {
          if (key === "spanContext")
            return () => ({
              ...target.spanContext(),
              traceState: createTraceState("k=v"),
            });
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      shared[customizersKey] = [
        {
          onSpanExport(data: Data) {
            expect(data.spanContext.traceState).toBe("k=v");
            if (fail) throw new Error("PRIVATE");
            data.spanContext.traceState = "x=y";
            data.spanContext.isRemote = true;
            return data;
          },
        },
      ];
      await send([withTraceState]);
      expect(received()).toHaveLength(1);
      expect(received()[0].traceState).toBe("k=v");
    },
  );

  test("stripped spans do not split ResourceSpans for later spans", async () => {
    const [child, root] = await fixture();
    const third = new Proxy(child, {
      get(target, key) {
        if (key === "name") return "third";
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    shared[customizersKey] = [
      {
        onSpanExport(data: Data) {
          if (data.name === "PRIVATE-root") throw new Error("PRIVATE");
          return data;
        },
      },
    ];
    await send([child, root, third]);
    expect(received()).toHaveLength(3);
    // One entry for the stripped span's empty resource, one shared by the rest.
    expect(bodies[0].resourceSpans).toHaveLength(2);
  });

  test("drops malformed spans with a safe diagnostic and exports the rest", async () => {
    const [child, root] = await fixture();
    const malformed = new Proxy(root, {
      get(target, key) {
        if (key === "startTime") return undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    shared[customizersKey] = [{ onSpanExport: (data: Data) => data }];
    await send([child, malformed]);
    expect(received().map((span) => span.name)).toEqual(["PRIVATE-child"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("PRIVATE");
  });

  test("does not customize unsampled recorded spans", async () => {
    const hook = vi.fn((data: Data) => data);
    shared[customizersKey] = [{ onSpanExport: hook }];
    const processor = new BraintrustSpanProcessor({
      apiKey: "test",
      apiUrl,
      parent: "project_name:test",
    });
    const provider = createTracerProvider(BasicTracerProvider, [processor], {
      sampler: {
        shouldSample: () => ({ decision: SamplingDecision.RECORD }),
        toString: () => "RecordOnly",
      },
    });
    try {
      provider.getTracer("unsampled").startSpan("recorded").end();
      await provider.forceFlush();
    } finally {
      await provider.shutdown();
    }
    expect(hook).not.toHaveBeenCalled();
    expect(received()).toEqual([]);
  });

  test("keeps non-finite numeric attributes instead of stripping the span", async () => {
    const [span] = await fixture();
    const nonFinite = new Proxy(span, {
      get(target, key) {
        if (key === "attributes")
          return { nan: NaN, inf: Infinity, list: [-Infinity] };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const hook = vi.fn((data: Data) => {
      expect(Number.isNaN(data.attributes.nan)).toBe(true);
      expect(data.attributes.inf).toBe(Infinity);
      return data;
    });
    shared[customizersKey] = [{ onSpanExport: hook }];
    await send([nonFinite]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    const [exported] = received();
    expect(exported.name).toBe(span.name);
    expect(JSON.stringify(exported)).not.toContain("customizer_error");
    expect(exported.attributes.map((attr: Data) => attr.key)).toEqual(
      expect.arrayContaining(["nan", "inf", "list"]),
    );
  });

  test("passes spans through when braintrust lacks the customizer runtime", async () => {
    const runtimeKey = Symbol.for("braintrust.spanCustomizerRuntime");
    const runtime = shared[runtimeKey];
    expect(runtime).toBeDefined();
    expect("_internalSpanCustomizer" in braintrust).toBe(false);
    const hook = vi.fn((data: Data) => data);
    shared[customizersKey] = [{ onSpanExport: hook }];
    delete shared[runtimeKey];
    try {
      await send(await fixture());
    } finally {
      shared[runtimeKey] = runtime;
    }
    expect(hook).not.toHaveBeenCalled();
    expect(received().map((span) => span.name)).toEqual([
      "PRIVATE-child",
      "PRIVATE-root",
    ]);
  });

  test("spans sharing a resource stay in one ResourceSpans entry", async () => {
    shared[customizersKey] = [{ onSpanExport: (data: Data) => data }];
    await send(await fixture());
    expect(received()).toHaveLength(2);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].resourceSpans).toHaveLength(1);
  });

  test("a failing later customizer cannot mutate another span's resource", async () => {
    const spans = await fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    shared[customizersKey] = [
      { onSpanExport: (data: Data) => data },
      {
        onSpanExport(data: Data) {
          if (data.name === "PRIVATE-root") {
            data.resource.attributes.secret = "CUSTOMIZER-SECRET";
            throw new Error("CUSTOMIZER-SECRET");
          }
          return data;
        },
      },
    ];

    await send(spans);

    const output = received();
    expect(
      output.find((span) => span.spanId === spans[0].spanContext().spanId),
    ).toHaveProperty("name", "PRIVATE-child");
    const failed = output.find(
      (span) => span.spanId === spans[1].spanContext().spanId,
    )!;
    expect(failed.name).toBe("");
    expect(failed.attributes).toContainEqual({
      key: "braintrust.context_json",
      value: { stringValue: '{"customizer_error":true}' },
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(spans[0].resource.attributes.secret).toBeUndefined();
    expect(JSON.stringify(bodies)).not.toContain("CUSTOMIZER-SECRET");
  });

  test("customFilter sees span origin context before customization", async () => {
    const contexts: unknown[] = [];
    shared[customizersKey] = [{ onSpanExport: (data: Data) => data }];
    const processor = new BraintrustSpanProcessor({
      apiKey: "test",
      apiUrl,
      parent: "project_name:test",
      filterAISpans: true,
      customFilter: (span) => {
        contexts.push(span.attributes["braintrust.context_json"]);
        return true;
      },
    });
    const provider = createTracerProvider(BasicTracerProvider, [processor]);
    try {
      provider.getTracer("consumer").startSpan("plain").end();
      await provider.forceFlush();
    } finally {
      await provider.shutdown();
    }
    expect(contexts).toHaveLength(1);
    expect(JSON.parse(contexts[0] as string)).toHaveProperty("span_origin");
    expect(received().map((span) => span.name)).toEqual(["plain"]);
  });
});
