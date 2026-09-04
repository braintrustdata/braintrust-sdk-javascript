import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown> };

describe("package exports", () => {
  test("publishes the curated entrypoints", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [
        ".",
        "./apply-auto-instrumentation",
        "./edge-light",
        "./esbuild",
        "./hook.mjs",
        "./instrumentation",
        "./next",
        "./node",
        "./package.json",
        "./rollup",
        "./vite",
        "./vitest-evals-reporter",
        "./webpack",
        "./workerd",
      ].sort(),
    );
  });

  test("does not publish legacy or implementation entrypoints", () => {
    expect(packageJson.exports).not.toHaveProperty("./browser");
    expect(packageJson.exports).not.toHaveProperty("./util");
    expect(packageJson.exports).not.toHaveProperty("./webpack-loader");
    expect(packageJson.exports).not.toHaveProperty("./internal");
    expect(packageJson.exports).not.toHaveProperty("./internal/webpack-loader");
  });
});
