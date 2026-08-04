import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const define = {
  __BRAINTRUST_SDK_VERSION__: JSON.stringify(packageJson.version),
};

export default defineConfig([
  // Node.js entrypoint
  {
    entry: {
      index: "src/node/index.ts",
      "apply-auto-instrumentation":
        "src/node/apply-auto-instrumentation-entry.ts",
      "vitest-evals-reporter": "src/wrappers/vitest-evals/reporter.ts",
    },
    format: ["cjs", "esm"],
    outDir: "dist",
    external: ["zod"],
    removeNodeProtocol: false,
    dts: {
      // Split DTS generation to reduce memory usage
      compilerOptions: {
        skipLibCheck: true,
      },
    },
    splitting: true,
    define,
    clean: true,
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["cjs"],
    removeNodeProtocol: false,
    outDir: "dist",
    external: ["esbuild", "prettier", "typescript", "zod"],
    // CLI doesn't need DTS
    dts: false,
    define,
    clean: false,
  },
  {
    entry: ["dev/index.ts"],
    format: ["cjs", "esm"],
    outDir: "dev/dist",
    removeNodeProtocol: false,
    external: ["esbuild", "prettier", "typescript", "zod"],
    dts: {
      // Split DTS generation to reduce memory usage
      compilerOptions: {
        skipLibCheck: true,
      },
    },
    splitting: true,
    define,
    clean: true,
  },
  {
    entry: ["util/index.ts"],
    format: ["cjs", "esm"],
    outDir: "util/dist",
    external: ["esbuild", "prettier", "typescript", "zod"],
    removeNodeProtocol: false,
    dts: {
      // Split DTS generation to reduce memory usage
      compilerOptions: {
        skipLibCheck: true,
      },
    },
    splitting: true,
    define,
    clean: true,
  },
  // Browser/edge entrypoints
  {
    entry: {
      browser: "src/browser/index.ts",
      "edge-light": "src/edge-light/index.ts",
      workerd: "src/workerd/index.ts",
      "apply-auto-instrumentation.browser":
        "src/non-node/apply-auto-instrumentation-entry.ts",
    },
    format: ["cjs", "esm"],
    outDir: "dist",
    external: ["zod"],
    removeNodeProtocol: false,
    platform: "browser",
    splitting: false,
    dts: true,
    define,
    clean: false,
  },
  {
    entry: ["src/instrumentation/index.ts"],
    format: ["cjs", "esm"],
    outDir: "dist/instrumentation",
    external: ["@braintrust/instrumentation-core", "zod"],
    dts: {
      compilerOptions: {
        skipLibCheck: true,
      },
    },
    splitting: false,
    define,
    clean: true,
  },
  {
    entry: [
      "src/auto-instrumentations/index.ts",
      "src/auto-instrumentations/loader/cjs-patch.ts",
      "src/auto-instrumentations/loader/get-package-version.ts",
      "src/auto-instrumentations/bundler/vite.ts",
      "src/auto-instrumentations/bundler/webpack.ts",
      "src/auto-instrumentations/bundler/next.ts",
      "src/auto-instrumentations/bundler/esbuild.ts",
      "src/auto-instrumentations/bundler/rollup.ts",
    ],
    format: ["cjs", "esm"],
    outDir: "dist/auto-instrumentations",
    dts: true,
    external: ["zod"],
    define,
    outExtension({ format }) {
      if (format === "esm") {
        return { js: ".mjs" };
      }
      return { js: ".cjs" };
    },
    clean: true,
  },
  {
    entry: {
      "bundler/webpack-loader":
        "src/auto-instrumentations/bundler/webpack-loader.ts",
    },
    format: ["cjs"],
    outDir: "dist/auto-instrumentations",
    dts: true,
    external: ["zod"],
    define,
    outExtension() {
      return { js: ".cjs" };
    },
    clean: false,
  },
  {
    entry: [
      "src/auto-instrumentations/hook.mts",
      "src/auto-instrumentations/loader/esm-hook.mts",
    ],
    format: ["esm"],
    outDir: "dist/auto-instrumentations",
    dts: false,
    platform: "node",
    external: ["@anthropic-ai/sdk", "zod"],
    define,
    outExtension({ format }) {
      return { js: ".mjs" };
    },
    clean: false,
  },
]);
