import { describe, expect, it } from "vitest";
import {
  classifyMastraTarget,
  patchMastraSource,
} from "./mastra-observability-patch";

describe("classifyMastraTarget", () => {
  it("identifies @mastra/core main and submodule entries", () => {
    expect(classifyMastraTarget("@mastra/core", "dist/index.js")).toBe("core");
    expect(classifyMastraTarget("@mastra/core", "dist/index.cjs")).toBe("core");
    expect(classifyMastraTarget("@mastra/core", "dist/mastra/index.js")).toBe(
      "core",
    );
    expect(classifyMastraTarget("@mastra/core", "dist/mastra/index.cjs")).toBe(
      "core",
    );
  });

  it("identifies @mastra/observability entry", () => {
    expect(classifyMastraTarget("@mastra/observability", "dist/index.js")).toBe(
      "observability",
    );
    expect(
      classifyMastraTarget("@mastra/observability", "dist/index.cjs"),
    ).toBe("observability");
  });

  it("returns null for unrelated paths", () => {
    expect(
      classifyMastraTarget("@mastra/core", "dist/agent/index.js"),
    ).toBeNull();
    expect(
      classifyMastraTarget("@mastra/core", "dist/chunk-XYZ.js"),
    ).toBeNull();
    expect(classifyMastraTarget("openai", "dist/index.js")).toBeNull();
  });
});

describe("patchMastraSource — @mastra/core ESM entry", () => {
  it("rewrites a thin re-export into a Proxy-wrapped class", () => {
    const original = `export { Mastra } from './chunk-PLCLLPJL.js';\n`;
    const patched = patchMastraSource(original, "core", "esm");

    // The rewritten source must import the original class from the same chunk
    expect(patched).toContain(
      `import { Mastra as __braintrustOrigMastra } from "./chunk-PLCLLPJL.js"`,
    );
    // It must wrap in a Proxy with a `construct` trap
    expect(patched).toContain("new Proxy(__braintrustOrigMastra,");
    expect(patched).toContain("construct(target, args, newTarget)");
    // It must re-export `Mastra` so consumers' bindings are unchanged
    expect(patched).toContain("export { Mastra }");
    // It must pull Observability via createRequire so it resolves from the
    // user's node_modules tree (not our SDK's)
    expect(patched).toContain("createRequire");
    expect(patched).toContain(`__braintrustRequire("@mastra/observability")`);
  });

  it("returns the original source when the re-export shape doesn't match", () => {
    const original = `// arbitrary code that doesn't re-export Mastra\n`;
    const patched = patchMastraSource(original, "core", "esm");
    expect(patched).toBe(original);
  });

  it("preserves the exact chunk path Mastra references", () => {
    const original = `export { Mastra } from '../chunk-DIFFERENT.js';\n`;
    const patched = patchMastraSource(original, "core", "esm");
    expect(patched).toContain("../chunk-DIFFERENT.js");
  });
});

describe("patchMastraSource — @mastra/core CJS entry", () => {
  it("rewrites the require + defineProperty shape into a Proxy", () => {
    const original = `'use strict';
var chunkVOP4TUHG_cjs = require('./chunk-VOP4TUHG.cjs');
Object.defineProperty(exports, "Mastra", {
  enumerable: true,
  get: function () { return chunkVOP4TUHG_cjs.Mastra; }
});
`;
    const patched = patchMastraSource(original, "core", "cjs");

    expect(patched).toContain(`require("./chunk-VOP4TUHG.cjs")`);
    expect(patched).toContain(`require("@mastra/observability")`);
    expect(patched).toContain("__braintrustChunk.Mastra");
    expect(patched).toContain("new Proxy(");
    expect(patched).toContain(`Object.defineProperty(exports, "Mastra"`);
  });
});

describe("patchMastraSource — @mastra/observability entry", () => {
  it("appends a Proxy wrap, leaving the original source intact above", () => {
    const original = `var Observability = class extends MastraBase {};\nexport { Observability };\n`;
    const patched = patchMastraSource(original, "observability", "esm");

    // Original source still starts the file
    expect(patched.startsWith(original)).toBe(true);
    // Append wraps the Observability binding via Proxy
    expect(patched).toContain("function __braintrustWrapObservability");
    expect(patched).toContain(
      `if (typeof Observability === "undefined") return`,
    );
    expect(patched).toContain("new Proxy(__OriginalObservability");
    expect(patched).toContain("factory()");
    expect(patched).toContain("__braintrustWrapped");
  });

  it("doesn't depend on chunk path extraction for observability", () => {
    // The Observability entry is one big inline file, not a re-export.
    // patchMastraSource should still produce a valid append even when no
    // chunk-shaped pattern is present in the source.
    const original = `// big inline bundle\nvar Observability = class {};\nexport { Observability };\n`;
    const patched = patchMastraSource(original, "observability", "esm");
    expect(patched).not.toBe(original);
    expect(patched.length).toBeGreaterThan(original.length);
  });
});
