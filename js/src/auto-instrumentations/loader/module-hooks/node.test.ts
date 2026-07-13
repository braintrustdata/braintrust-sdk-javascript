import { describe, expect, it, vi } from "vitest";
import { debugLogger } from "../../../debug-logger";
import { createHook as createImportInTheMiddleHook } from "../../import-in-the-middle/create-hook.mjs";
import type { ModuleExportPatchConfig } from "./registry";
import {
  installNodeModuleExportHooks,
  type NodeModuleExportHookRuntime,
} from "./node";

describe("installNodeModuleExportHooks", () => {
  it("uses in-process registerHooks when synchronous hooks are supported", () => {
    const events: string[] = [];
    const importHook = makeNoopImportHook({
      initialize(data: unknown) {
        events.push(`initialize:${JSON.stringify(data)}`);
        return Promise.resolve();
      },
    });

    installNodeModuleExportHooks({
      asyncImportHookUrl:
        "file:///braintrust/hook.mjs?braintrust-iitm-loader=true",
      configs: [fakeConfig()],
      registryImportUrl: "file:///braintrust/hook.mjs",
      runtime: fakeRuntime(events, {
        createImportHook(meta, options) {
          events.push(`create:${meta.url}:${options.registerUrl}`);
          return importHook as ReturnType<
            NodeModuleExportHookRuntime["createImportHook"]
          >;
        },
        register() {
          events.push("register");
        },
        registerHooks(hooks) {
          events.push(
            `registerHooks:${typeof hooks.resolve}:${typeof hooks.load}`,
          );
        },
        supportsSyncHooks: () => true,
      }),
    });

    expect(events).toEqual([
      "create:file:///braintrust/hook.mjs:file:///braintrust/hook.mjs",
      'initialize:{"include":["pkg"]}',
      "registerHooks:function:function",
      "importHook:pkg",
      "importHookPatched:patched",
      "requireHook:pkg",
      "requireHookPatched:patched",
    ]);
  });

  it("falls back to self-registering hook.mjs as the async loader", () => {
    const events: string[] = [];
    const asyncImportHookUrl =
      "file:///braintrust/hook.mjs?braintrust-iitm-loader=true";

    installNodeModuleExportHooks({
      asyncImportHookUrl,
      configs: [fakeConfig()],
      registryImportUrl: "file:///braintrust/hook.mjs",
      runtime: fakeRuntime(events, {
        register(specifier, options) {
          events.push(`register:${specifier}:${JSON.stringify(options)}`);
        },
        registerHooks() {
          events.push("registerHooks");
        },
        supportsSyncHooks: () => false,
      }),
    });

    expect(events).toEqual([
      `register:${asyncImportHookUrl}:{"data":{"include":["pkg"]}}`,
      "importHook:pkg",
      "importHookPatched:patched",
      "requireHook:pkg",
      "requireHookPatched:patched",
    ]);
  });

  it("passes the loaded package version to constrained hooks", () => {
    const events: string[] = [];

    installNodeModuleExportHooks({
      asyncImportHookUrl:
        "file:///braintrust/hook.mjs?braintrust-iitm-loader=true",
      configs: [fakeConfig(">=2.0.0")],
      registryImportUrl: "file:///braintrust/hook.mjs",
      runtime: fakeRuntime(events, {
        baseDir: "/pkg",
        getPackageVersion(baseDir) {
          events.push(`version:${baseDir}`);
          return "1.0.0";
        },
        supportsSyncHooks: () => false,
      }),
    });

    expect(events).toEqual([
      "register",
      "importHook:pkg",
      "version:/pkg",
      "importHookPatched:original",
      "requireHook:pkg",
      "version:/pkg",
      "requireHookPatched:original",
    ]);
  });

  it("does not throw when ESM or CJS hook installation fails", () => {
    const warnSpy = vi.spyOn(debugLogger, "warn").mockImplementation(() => {});

    expect(() =>
      installNodeModuleExportHooks({
        asyncImportHookUrl:
          "file:///braintrust/hook.mjs?braintrust-iitm-loader=true",
        configs: [fakeConfig()],
        registryImportUrl: "file:///braintrust/hook.mjs",
        runtime: {
          createImportHook: (() => {
            throw new Error("esm");
          }) as NodeModuleExportHookRuntime["createImportHook"],
          importHookConstructor: class {},
          moduleApi: {
            register() {
              throw new Error("register");
            },
          },
          requireHookConstructor: class {
            constructor() {
              throw new Error("cjs");
            }
          },
          supportsSyncHooks: () => true,
        },
      }),
    ).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to install ESM module export hooks",
      expect.any(Error),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to install CJS module export hooks",
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});

describe("merged import-in-the-middle wrapper generation", () => {
  it("imports register state from the canonical Braintrust hook URL", async () => {
    const hook = createImportInTheMiddleHook(
      { url: "file:///braintrust/hook.mjs?braintrust-iitm-loader=true" },
      { registerUrl: "file:///braintrust/hook.mjs" },
    );
    await hook.initialize({ include: ["target"] });

    const resolved = (await hook.resolve(
      "target",
      { conditions: ["import"], parentURL: "file:///app.mjs" },
      async () => ({ format: "module", url: "file:///target.mjs" }),
    )) as { url: string };
    const loaded = (await hook.load(
      resolved.url,
      { format: "module" },
      async () => ({
        format: "module",
        source: 'export const value = "original";',
      }),
    )) as { source: string };

    expect(loaded.source).toContain(
      "import registerState from 'file:///braintrust/hook.mjs'",
    );
    expect(loaded.source).not.toContain("lib/register.");
  });
});

function fakeConfig(versionRange?: string): ModuleExportPatchConfig {
  return {
    integrations: ["mastra"],
    modules: [
      {
        packageName: "pkg",
        patches: [
          {
            channelName: "orchestrion:pkg:Target.constructor",
            exportName: "Target",
            kind: "constructor",
          },
        ],
        specifier: "pkg",
        versionRange,
      },
    ],
    targets: ["node"],
  };
}

function fakeRuntime(
  events: string[],
  {
    createImportHook,
    baseDir,
    getPackageVersion,
    register,
    registerHooks,
    supportsSyncHooks,
  }: {
    baseDir?: string;
    createImportHook?: NodeModuleExportHookRuntime["createImportHook"];
    getPackageVersion?: NodeModuleExportHookRuntime["getPackageVersion"];
    register?: (specifier: string, options?: unknown) => void;
    registerHooks?: (hooks: { load: unknown; resolve: unknown }) => void;
    supportsSyncHooks: () => boolean;
  },
): Partial<NodeModuleExportHookRuntime> {
  class FakeImportHook {
    constructor(
      modules: string[],
      hookFn: (
        exportsValue: unknown,
        name: string,
        baseDir?: string,
      ) => unknown,
    ) {
      events.push(`importHook:${modules.join(",")}`);
      const namespace = {
        Target: class {
          constructor(public readonly value: string) {}
        },
      };
      hookFn(namespace, "pkg", baseDir);
      events.push(
        `importHookPatched:${new namespace.Target("original").value}`,
      );
    }
  }
  class FakeRequireHook {
    constructor(
      modules: string[],
      hookFn: (
        exportsValue: unknown,
        name: string,
        baseDir?: string,
      ) => unknown,
    ) {
      events.push(`requireHook:${modules.join(",")}`);
      const namespace = {
        Target: class {
          constructor(public readonly value: string) {}
        },
      };
      hookFn(namespace, "pkg", baseDir);
      events.push(
        `requireHookPatched:${new namespace.Target("original").value}`,
      );
    }
  }
  return {
    createImportHook: createImportHook ?? (() => makeNoopImportHook()),
    ...(getPackageVersion ? { getPackageVersion } : {}),
    importHookConstructor: FakeImportHook,
    moduleApi: {
      register:
        register ??
        (() => {
          events.push("register");
        }),
      registerHooks,
    },
    patchRuntime: {
      resolveModule: () => undefined,
      traceConstructor(_channelName, event, construct) {
        event.arguments[0] = "patched";
        return construct();
      },
    },
    requireHookConstructor: FakeRequireHook,
    supportsSyncHooks,
  };
}

function makeNoopImportHook({
  initialize,
}: {
  initialize?: (data: unknown) => Promise<void>;
} = {}): ReturnType<NodeModuleExportHookRuntime["createImportHook"]> {
  return {
    applyOptions() {},
    initialize: initialize ?? (() => Promise.resolve()),
    async load() {
      return { format: "module", source: "" };
    },
    loadSync() {
      return { format: "module", source: "" };
    },
    async resolve() {
      return { url: "file:///noop.mjs" };
    },
    resolveSync() {
      return { url: "file:///noop.mjs" };
    },
  };
}
