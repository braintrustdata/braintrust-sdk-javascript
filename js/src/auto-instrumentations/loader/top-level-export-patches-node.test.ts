import { describe, expect, it } from "vitest";
import {
  installNodeTopLevelExportPatches,
  type NodeTopLevelExportPatchRuntime,
} from "./top-level-export-patches-node";
import { createHook as createImportInTheMiddleHook } from "../import-in-the-middle/create-hook.mjs";
import type { TopLevelImportHook } from "./top-level-export-patches";

describe("installNodeTopLevelExportPatches", () => {
  it("uses in-process registerHooks when synchronous hooks are supported", () => {
    const events: string[] = [];
    const importHook = {
      initialize(data: unknown) {
        events.push(`initialize:${JSON.stringify(data)}`);
        return Promise.resolve();
      },
      async load() {},
      loadSync() {},
      async resolve() {},
      resolveSync() {},
    };

    installNodeTopLevelExportPatches({
      asyncImportHookUrl:
        "file:///braintrust/hook.mjs?braintrust-iitm-loader=true",
      hooks: [fakeHook()],
      registryImportUrl: "file:///braintrust/hook.mjs",
      runtime: fakeRuntime(events, {
        createImportHook(meta, options) {
          events.push(`create:${meta.url}:${options.registerUrl}`);
          return importHook;
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

    installNodeTopLevelExportPatches({
      asyncImportHookUrl,
      hooks: [fakeHook()],
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
});

describe("merged import-in-the-middle wrapper generation", () => {
  it("imports register from the canonical Braintrust hook URL", async () => {
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
      "import { register } from 'file:///braintrust/hook.mjs'",
    );
    expect(loaded.source).not.toContain("lib/register.js");
  });
});

function fakeHook(): TopLevelImportHook {
  return {
    hook(exportsValue) {
      (exportsValue as { value: string }).value = "patched";
    },
    integrations: ["mastra"],
    specifiers: ["pkg"],
    targets: ["node"],
  };
}

function fakeRuntime(
  events: string[],
  {
    createImportHook,
    register,
    registerHooks,
    supportsSyncHooks,
  }: {
    createImportHook?: NodeTopLevelExportPatchRuntime["createImportHook"];
    register?: (specifier: string, options?: unknown) => void;
    registerHooks?: (hooks: { load: unknown; resolve: unknown }) => void;
    supportsSyncHooks: () => boolean;
  },
): Partial<NodeTopLevelExportPatchRuntime> {
  class FakeImportHook {
    constructor(
      modules: string[],
      hookFn: (exportsValue: unknown, name: string) => unknown,
    ) {
      events.push(`importHook:${modules.join(",")}`);
      const namespace = { value: "original" };
      hookFn(namespace, "pkg");
      events.push(`importHookPatched:${namespace.value}`);
    }
  }
  class FakeRequireHook {
    constructor(
      modules: string[],
      hookFn: (exportsValue: unknown, name: string) => unknown,
    ) {
      events.push(`requireHook:${modules.join(",")}`);
      const namespace = { value: "original" };
      hookFn(namespace, "pkg");
      events.push(`requireHookPatched:${namespace.value}`);
    }
  }
  return {
    createImportHook:
      createImportHook ??
      (() => ({
        initialize: () => Promise.resolve(),
        async load() {},
        loadSync() {},
        async resolve() {},
        resolveSync() {},
      })),
    importHookConstructor: FakeImportHook,
    moduleApi: {
      register:
        register ??
        (() => {
          events.push("register");
        }),
      registerHooks,
    },
    requireHookConstructor: FakeRequireHook,
    supportsSyncHooks,
  };
}
