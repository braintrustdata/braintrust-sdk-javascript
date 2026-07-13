import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModuleExportSourceWrapper,
  filterModuleExportPatchConfigs,
  getModuleExportPatchSpecifiers,
  installModuleExportPatchRunner,
  runModuleExportPatches,
  type ModuleExportConstructorEvent,
  type ModuleExportPatchConfig,
  type ModuleExportPatchRuntime,
  type ModuleExportPatchTarget,
} from "./registry";

const runnerKey = "__braintrustTopLevelImportHookRunner";

describe("module export patch registry", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[runnerKey];
  });

  it("filters configs by target and disabled integrations", () => {
    const nodeConfig = fakeConfig("node", { integrations: ["mastra"] });
    const browserConfig = fakeConfig("browser", {
      integrations: ["openai"],
    });

    expect(
      filterModuleExportPatchConfigs([nodeConfig, browserConfig], {
        target: "node",
      }),
    ).toEqual([nodeConfig]);
    expect(
      filterModuleExportPatchConfigs([nodeConfig, browserConfig], {
        disabledIntegrationConfig: { mastra: false },
        target: "node",
      }),
    ).toEqual([]);
  });

  it("collects unique runtime specifiers in first-seen order", () => {
    expect(
      getModuleExportPatchSpecifiers([
        fakeConfig("node", { moduleSpecifiers: ["pkg-a", "pkg-b"] }),
        fakeConfig("node", { moduleSpecifiers: ["pkg-b", "pkg-c"] }),
      ]),
    ).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
  });

  it("wraps constructors and lets channel subscribers mutate arguments", () => {
    class Target {
      constructor(public readonly value: string) {}
    }
    const namespace = { Target };
    const runtime = fakeRuntime({
      traceConstructor(_channelName, event, construct) {
        event.arguments[0] = "patched";
        return construct();
      },
    });

    const result = runModuleExportPatches(
      [fakeConfig("node")],
      namespace,
      { moduleName: "pkg" },
      runtime,
    ) as typeof namespace;

    expect(result).toBe(namespace);
    expect(new result.Target("original").value).toBe("patched");
  });

  it("passes module context and a safe resolver through constructor events", () => {
    class Target {}
    let seen: ModuleExportConstructorEvent | undefined;
    const resolveModule = vi.fn(() => ({ value: true }));
    const runtime = fakeRuntime({
      resolveModule,
      traceConstructor(_channelName, event, construct) {
        seen = event;
        expect(event.resolveModule("dependency")).toEqual({ value: true });
        return construct();
      },
    });
    const result = runModuleExportPatches(
      [fakeConfig("node")],
      { Target },
      {
        baseDir: "/pkg",
        moduleName: "pkg",
        moduleVersion: "2.1.0",
        resolutionBase: "file:///app.mjs",
      },
      runtime,
    ) as { Target: typeof Target };

    new result.Target();

    expect(seen).toMatchObject({
      baseDir: "/pkg",
      moduleName: "pkg",
      moduleVersion: "2.1.0",
      resolutionBase: "file:///app.mjs",
    });
    expect(resolveModule).toHaveBeenCalledWith("dependency", {
      baseDir: "/pkg",
      moduleName: "pkg",
      moduleVersion: "2.1.0",
      resolutionBase: "file:///app.mjs",
    });
  });

  it("applies only matching module versions", () => {
    class Target {}
    const runtime = fakeRuntime();
    const config = fakeConfig("node", { versionRange: ">=2.0.0 <3.0.0" });
    const matching = { Target };
    const nonMatching = { Target };

    runModuleExportPatches(
      [config],
      matching,
      { moduleName: "pkg", moduleVersion: "2.1.0" },
      runtime,
    );
    runModuleExportPatches(
      [config],
      nonMatching,
      { moduleName: "pkg", moduleVersion: "3.0.0" },
      runtime,
    );

    expect(matching.Target).not.toBe(Target);
    expect(nonMatching.Target).toBe(Target);
  });

  it("wraps each namespace once without changing constructor semantics", () => {
    let constructionCount = 0;
    class Target {
      constructor() {
        constructionCount++;
        throw new Error("user error");
      }
    }
    const namespace = { Target };
    const runtime = fakeRuntime();
    const config = fakeConfig("node");

    runModuleExportPatches([config], namespace, { moduleName: "pkg" }, runtime);
    runModuleExportPatches([config], namespace, { moduleName: "pkg" }, runtime);

    expect(() => new namespace.Target()).toThrow("user error");
    expect(constructionCount).toBe(1);
  });

  it("skips missing and non-constructor exports and contains lookup errors", () => {
    const runtime = fakeRuntime();
    const missing = { other: true };
    const throwing = Object.defineProperty({}, "Target", {
      get() {
        throw new Error("lookup failed");
      },
    });

    expect(
      runModuleExportPatches(
        [fakeConfig("node")],
        missing,
        { moduleName: "pkg" },
        runtime,
      ),
    ).toBe(missing);
    expect(() =>
      runModuleExportPatches(
        [fakeConfig("node")],
        throwing,
        { moduleName: "pkg" },
        runtime,
      ),
    ).not.toThrow();
  });

  it("clones immutable namespaces when installing a patched export", () => {
    class Target {}
    const namespace = Object.freeze({ Target });
    const result = runModuleExportPatches(
      [fakeConfig("node")],
      namespace,
      { moduleName: "pkg" },
      fakeRuntime(),
    ) as typeof namespace;

    expect(result).not.toBe(namespace);
    expect(result.Target).not.toBe(Target);
  });

  it("installs a non-enumerable global runner", () => {
    class Target {}
    installModuleExportPatchRunner([fakeConfig("node")], fakeRuntime());

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, runnerKey);
    const namespace = { Target };
    const result = (
      descriptor?.value as (
        exportsValue: unknown,
        name: string,
        baseDir?: string,
        resolutionBase?: string,
        moduleVersion?: string,
      ) => unknown
    )(namespace, "pkg", undefined, undefined, "1.0.0") as typeof namespace;

    expect(descriptor).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true,
    });
    expect(result.Target).not.toBe(Target);
  });

  it("generates ESM and CJS wrappers for matching source modules", () => {
    const config = fakeConfig("node");
    const esm = buildModuleExportSourceWrapper([config], {
      format: "esm",
      modulePath: "index.js",
      originalModuleSpecifier: "braintrust-top-level-original:0",
      packageName: "pkg",
      source: "export { Target } from './target.js';",
      target: "node",
    });
    const cjs = buildModuleExportSourceWrapper([config], {
      format: "cjs",
      modulePath: "index.js",
      originalModuleSpecifier: "/pkg/index.js?braintrust-top-level-original",
      packageName: "pkg",
      source: "exports.Target = Target;",
      target: "node",
    });

    expect(esm).toContain("__braintrustTopLevelImportHookRunner");
    expect(esm).toContain("__braintrustExports");
    expect(esm).toContain(" as Target");
    expect(cjs).toContain("__braintrustTopLevelImportHookRunner");
    expect(cjs).toContain('Object.defineProperty(exports, "Target"');
  });

  it("returns null for target and version mismatches", () => {
    const config = fakeConfig("node", { versionRange: ">=2.0.0" });
    const input = {
      format: "esm" as const,
      modulePath: "index.js",
      moduleVersion: "1.0.0",
      originalModuleSpecifier: "original",
      packageName: "pkg",
      source: "export class Target {}",
    };

    expect(
      buildModuleExportSourceWrapper([config], {
        ...input,
        target: "node",
      }),
    ).toBeNull();
    expect(
      buildModuleExportSourceWrapper([config], {
        ...input,
        moduleVersion: "2.0.0",
        target: "browser",
      }),
    ).toBeNull();
  });
});

function fakeConfig(
  target: ModuleExportPatchTarget,
  options: {
    integrations?: ModuleExportPatchConfig["integrations"];
    moduleSpecifiers?: string[];
    versionRange?: string;
  } = {},
): ModuleExportPatchConfig {
  return {
    integrations: options.integrations ?? ["mastra"],
    modules: (options.moduleSpecifiers ?? ["pkg"]).map((specifier) => ({
      packageName: specifier,
      patches: [
        {
          channelName: `orchestrion:${specifier}:Target.constructor`,
          exportName: "Target",
          kind: "constructor",
        },
      ],
      source: { modulePaths: ["index.js"] },
      specifier,
      versionRange: options.versionRange,
    })),
    targets: [target],
  };
}

function fakeRuntime(
  overrides: Partial<ModuleExportPatchRuntime> = {},
): ModuleExportPatchRuntime {
  return {
    resolveModule: () => undefined,
    traceConstructor: (_channelName, _event, construct) => construct(),
    ...overrides,
  };
}
