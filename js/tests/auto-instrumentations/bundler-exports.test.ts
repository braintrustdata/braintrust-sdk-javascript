import { describe, expect, it } from "vitest";

describe("bundler plugin exports", () => {
  it("exports braintrust-prefixed plugin aliases", async () => {
    const esbuild =
      await import("../../src/auto-instrumentations/bundler/esbuild.js");
    const rollup =
      await import("../../src/auto-instrumentations/bundler/rollup.js");
    const vite =
      await import("../../src/auto-instrumentations/bundler/vite.js");
    const webpack =
      await import("../../src/auto-instrumentations/bundler/webpack.js");

    expect(esbuild.braintrustEsbuildPlugin).toBe(esbuild.esbuildPlugin);
    expect(rollup.braintrustRollupPlugin).toBe(rollup.rollupPlugin);
    expect(vite.braintrustVitePlugin).toBe(vite.vitePlugin);
    expect(webpack.braintrustWebpackPlugin).toBe(webpack.webpackPlugin);
  });
});
