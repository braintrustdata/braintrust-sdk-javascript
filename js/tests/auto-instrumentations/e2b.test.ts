import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { transformSync } from "esbuild";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { create } from "../../src/auto-instrumentations/orchestrion-js";
import { getDefaultInstrumentationConfigs } from "../../src/auto-instrumentations/configs/all";
import { _exportsForTestingOnly, initLogger } from "../../src/logger";
import { configureNode } from "../../src/node/config";
import { runWithAutoInstrumentationSuppressed } from "../../src/instrumentation/auto-instrumentation-suppression";

configureNode();

// Execute the published SDK implementations through the same transformer used
// by the loader/bundlers. Only provider I/O is stubbed: these are hermetic SDK
// contract tests, not recordings of live E2B sandboxes.
function loadSDK(
  name: string,
  format: "cjs" | "esm",
  dependencies: Record<string, unknown> = {},
  disabled = false,
) {
  const require = createRequire(import.meta.url);
  const root = dirname(dirname(require.resolve(name)));
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const filePath = format === "cjs" ? "dist/index.js" : "dist/index.mjs";
  const source = readFileSync(join(root, filePath), "utf8");
  const transformer = create(
    getDefaultInstrumentationConfigs({
      disabledIntegrationConfig: disabled ? { e2b: false } : undefined,
    }),
  ).getTransformer(name, version, filePath);
  const transformed = transformer?.transform(source, format).code ?? source;
  const code =
    format === "esm"
      ? transformSync(transformed, { format: "cjs", platform: "node" }).code
      : transformed;
  const module = { exports: {} };
  const sdkRequire = createRequire(join(root, filePath));
  new Function("require", "module", "exports", code)(
    (id: string) => dependencies[id] ?? sdkRequire(id),
    module,
    module.exports,
  );
  return module.exports as typeof import("@e2b/code-interpreter");
}

describe.each(["cjs", "esm"] as const)("E2B published %s SDK", (format) => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({ projectName: "e2b.test.ts", projectId: "test-project-id" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  function sdks(disabled = false) {
    const core = loadSDK("e2b", format, {}, disabled);
    const interpreter = loadSDK(
      "@e2b/code-interpreter",
      format,
      { e2b: core },
      disabled,
    );
    return { core, interpreter };
  }

  function executionResponse(messages: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            messages.map((message) => JSON.stringify(message)).join("\n") +
              "\n",
            { status: 200 },
          ),
        ),
    );
  }

  it("traces both create overloads, preserves subclasses, and omits credentials", async () => {
    const { core, interpreter } = sdks();
    const coreSandbox = await core.Sandbox.create({
      debug: true,
      apiKey: "secret-api-key",
      timeoutMs: 1000,
    });
    const sandbox = await interpreter.Sandbox.create("code-interpreter", {
      debug: true,
      apiKey: "secret-api-key",
      envs: { TOKEN: "secret-environment" },
      timeoutMs: 1000,
    });
    expect(coreSandbox).toBeInstanceOf(core.Sandbox);
    expect(sandbox).toBeInstanceOf(interpreter.Sandbox);
    expect(typeof sandbox.runCode).toBe("function");
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      span_attributes: { name: "e2b.Sandbox.create", type: "tool" },
      input: { timeoutMs: 1000 },
      output: { sandboxId: coreSandbox.sandboxId },
    });
    expect(spans[1]).toMatchObject({
      input: { template: "code-interpreter", timeoutMs: 1000 },
      output: { sandboxId: sandbox.sandboxId },
    });
    expect(JSON.stringify(spans)).not.toContain("secret-");
  });

  it("preserves foreground results and background command handles", async () => {
    const { core } = sdks();
    const sandbox = await core.Sandbox.create({ debug: true });
    await backgroundLogger.drain();
    const result = { stdout: "hello\n", stderr: "", exitCode: 0 };
    const handle = {
      pid: 42,
      wait: vi.fn().mockResolvedValue(result),
      kill: vi.fn(),
    };
    // start() owns the transport; run() is the actual instrumented SDK method.
    const start = vi
      .spyOn(sandbox.commands as any, "start")
      .mockResolvedValue(handle);
    const options = {
      cwd: "/tmp",
      envs: { TOKEN: "secret-environment" },
      onStdout: vi.fn(),
    };
    expect(await sandbox.commands.run("echo hello", options)).toBe(result);
    expect(start).toHaveBeenCalledWith("echo hello", options);
    expect(await sandbox.commands.run("sleep 1", { background: true })).toBe(
      handle,
    );
    expect(handle.wait).toHaveBeenCalledTimes(1);
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      input: { command: "echo hello" },
      output: result,
      metadata: { cwd: "/tmp" },
    });
    expect(spans[1]).toMatchObject({
      metadata: { background: true },
      output: { pid: 42 },
    });
    expect(JSON.stringify(spans)).not.toContain("secret-environment");
  });

  it("captures execution results and preserves streaming callbacks and parentage", async () => {
    const { interpreter } = sdks();
    const sandbox = await interpreter.Sandbox.create({ debug: true });
    await backgroundLogger.drain();
    executionResponse([
      { type: "stdout", text: "hello\n" },
      { type: "stderr", text: "warning\n" },
      { type: "result", text: "2", is_main_result: true },
    ]);
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const onResult = vi.fn();
    const logger = initLogger({
      projectName: "e2b.test.ts",
      projectId: "test-project-id",
    });
    const result = await logger.traced(
      () =>
        sandbox.runCode("print('hello'); 1 + 1", {
          language: "python",
          onStdout,
          onStderr,
          onResult,
          envs: { TOKEN: "secret-environment" },
        }),
      { name: "agent" },
    );
    expect(result.text).toBe("2");
    expect(onStdout).toHaveBeenCalledOnce();
    expect(onStderr).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(result.results[0]);
    const spans = await backgroundLogger.drain();
    const child = spans.find(
      (span: any) => span.span_attributes?.name === "e2b.runCode",
    );
    const parent = spans.find(
      (span: any) => span.span_attributes?.name === "agent",
    ) as Record<string, unknown> | undefined;
    expect(child).toMatchObject({
      span_attributes: { type: "tool" },
      input: { code: "print('hello'); 1 + 1" },
      output: {
        logs: { stdout: ["hello\n"], stderr: ["warning\n"] },
        results: [{ text: "2" }],
      },
      metadata: {
        provider: "e2b",
        language: "python",
        sandboxId: sandbox.sandboxId,
      },
      span_parents: [parent!.span_id],
    });
    expect(JSON.stringify(spans)).not.toContain("secret-environment");
  });

  it("logs resolved execution errors without turning them into rejections", async () => {
    const { interpreter } = sdks();
    const sandbox = await interpreter.Sandbox.create({ debug: true });
    await backgroundLogger.drain();
    executionResponse([
      {
        type: "error",
        name: "ZeroDivisionError",
        value: "division by zero",
        traceback: "ZeroDivisionError: division by zero",
      },
    ]);
    const result = await sandbox.runCode("1 / 0");
    expect(result.error?.name).toBe("ZeroDivisionError");
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      error: "ZeroDivisionError: division by zero",
      output: { error: { name: "ZeroDivisionError" } },
    });
  });

  it("preserves rejected errors and ends their spans", async () => {
    const { interpreter } = sdks();
    const sandbox = await interpreter.Sandbox.create({ debug: true });
    await backgroundLogger.drain();
    const error = new Error("command failed");
    vi.spyOn(sandbox.commands as any, "start").mockRejectedValue(error);
    await expect(sandbox.commands.run("false")).rejects.toBe(error);
    await expect(
      // @ts-expect-error Exercise the SDK's runtime validation of incompatible options.
      sandbox.runCode("1", {
        language: "python",
        context: { id: "context", language: "python", cwd: "/tmp" },
      }),
    ).rejects.toThrow("context or language");
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span).toMatchObject({
        error: expect.any(String),
        metrics: { end: expect.any(Number) },
      });
    }
  });

  it("does not emit spans when disabled or suppressed", async () => {
    const { interpreter } = sdks(true);
    const sandbox = await interpreter.Sandbox.create({ debug: true });
    executionResponse([{ type: "stdout", text: "hello" }]);
    await sandbox.runCode("print('hello')");
    const enabled = sdks();
    await runWithAutoInstrumentationSuppressed(() =>
      enabled.core.Sandbox.create({ debug: true }),
    );
    expect(await backgroundLogger.drain()).toEqual([]);
  });
});
