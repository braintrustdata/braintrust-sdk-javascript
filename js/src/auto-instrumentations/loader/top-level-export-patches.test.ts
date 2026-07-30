import { describe, expect, it } from "vitest";
import {
  buildTopLevelImportHookSourceWrapper,
  getDefaultTopLevelImportHooks,
  getTopLevelImportHookSpecifiers,
  runTopLevelImportHooks,
  type TopLevelImportHook,
} from "./top-level-export-patches";

describe("top-level import hook registry", () => {
  it("returns the Mastra runtime specifiers for node targets", () => {
    const hooks = getDefaultTopLevelImportHooks({ target: "node" });

    expect(getTopLevelImportHookSpecifiers(hooks)).toEqual([
      "@mastra/core",
      "@mastra/core/mastra",
      "@mastra/observability",
    ]);
  });

  it("filters hooks by disabled integration config", () => {
    const hooks = getDefaultTopLevelImportHooks({
      disabledIntegrationConfig: { mastra: false },
      target: "node",
    });

    expect(hooks).toEqual([]);
  });

  it("does not include Mastra for browser targets", () => {
    const hooks = getDefaultTopLevelImportHooks({ target: "browser" });

    expect(hooks).toEqual([]);
  });

  it("runs hook callbacks against a mutable namespace", () => {
    const hooks: TopLevelImportHook[] = [
      {
        hook(exportsValue) {
          exportsValue.value = "patched";
        },
        integrations: ["mastra"],
        specifiers: ["pkg"],
        targets: ["node"],
      },
    ];
    const namespace = { value: "original" };

    const result = runTopLevelImportHooks(hooks, namespace, {
      moduleName: "pkg",
    });

    expect(result).toBe(namespace);
    expect(namespace.value).toBe("patched");
  });

  it("uses a returned replacement namespace when a hook provides one", () => {
    const replacement = { value: "replacement" };
    const hooks: TopLevelImportHook[] = [
      {
        hook() {
          return replacement;
        },
        integrations: ["mastra"],
        specifiers: ["pkg"],
        targets: ["node"],
      },
    ];

    const result = runTopLevelImportHooks(
      hooks,
      { value: "original" },
      { moduleName: "pkg" },
    );

    expect(result).toBe(replacement);
  });

  it("passes runtime resolution context through hook callbacks", () => {
    let seen:
      | { baseDir: string | undefined; resolutionBase: string | undefined }
      | undefined;
    const hooks: TopLevelImportHook[] = [
      {
        hook(_exportsValue, _name, baseDir, resolutionBase) {
          seen = { baseDir, resolutionBase };
        },
        integrations: ["mastra"],
        specifiers: ["pkg"],
        targets: ["node"],
      },
    ];

    runTopLevelImportHooks(
      hooks,
      { value: "original" },
      {
        baseDir: "/tmp/pkg",
        moduleName: "pkg",
        resolutionBase: "file:///tmp/app/bundle.mjs",
      },
    );

    expect(seen).toEqual({
      baseDir: "/tmp/pkg",
      resolutionBase: "file:///tmp/app/bundle.mjs",
    });
  });

  it("generates an ESM wrapper that calls the shared hook runner", () => {
    const wrapper = buildTopLevelImportHookSourceWrapper([fakeHook("node")], {
      format: "esm",
      modulePath: "index.js",
      originalModuleSpecifier: "braintrust-top-level-original:0",
      packageName: "pkg",
      source: `export { value } from "./value.js";`,
      target: "node",
    });

    expect(wrapper).toContain(
      `import * as __braintrustOriginal from "braintrust-top-level-original:0"`,
    );
    expect(wrapper).toContain("__braintrustTopLevelImportHookRunner");
    expect(wrapper).toContain(
      `export * from "braintrust-top-level-original:0"`,
    );
    expect(wrapper).toContain("import.meta.url");
    expect(wrapper).toContain(" as value");
  });

  it("generates a CJS wrapper that calls the shared hook runner", () => {
    const wrapper = buildTopLevelImportHookSourceWrapper([fakeHook("node")], {
      format: "cjs",
      modulePath: "index.cjs",
      originalModuleSpecifier: "/tmp/pkg/index.cjs?braintrust-original",
      packageName: "pkg",
      source: `exports.value = "original";`,
      target: "node",
    });

    expect(wrapper).toContain(
      `const __braintrustOriginal = require("/tmp/pkg/index.cjs?braintrust-original")`,
    );
    expect(wrapper).toContain("__braintrustTopLevelImportHookRunner");
    expect(wrapper).toContain("typeof __filename");
    expect(wrapper).toContain(`Object.defineProperty(exports, "value"`);
  });

  it("supports browser-safe hook descriptors while Mastra remains node-only", () => {
    const wrapper = buildTopLevelImportHookSourceWrapper(
      [fakeHook("browser")],
      {
        format: "esm",
        modulePath: "index.js",
        originalModuleSpecifier: "braintrust-top-level-original:1",
        packageName: "pkg",
        source: `export const value = "original";`,
        target: "browser",
      },
    );

    expect(wrapper).toContain("__braintrustTopLevelImportHookRunner");
    expect(getDefaultTopLevelImportHooks({ target: "browser" })).toEqual([]);
  });
});

function fakeHook(target: "node" | "browser"): TopLevelImportHook {
  return {
    hook(exportsValue) {
      exportsValue.value = "patched";
    },
    integrations: ["mastra"],
    sourceTargets: [
      {
        exportNames: ["value"],
        modulePaths:
          target === "node" ? ["index.js", "index.cjs"] : ["index.js"],
        packageName: "pkg",
        specifier: "pkg",
      },
    ],
    specifiers: ["pkg"],
    targets: [target],
  };
}
