import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const define = {
  __BRAINTRUST_SDK_VERSION__: JSON.stringify(packageJson.version),
};

const nodeEntries = {
  index: "src/node/index.ts",
  "custom-views": "src/custom-views/exports.ts",
  preprocessors: "src/preprocessors/exports.ts",
  "apply-auto-instrumentation": "src/node/apply-auto-instrumentation-entry.ts",
  "vitest-evals-reporter": "src/wrappers/vitest-evals/reporter.ts",
};

export default defineConfig([
  // Node.js entrypoint
  {
    entry: {
      ...nodeEntries,
      livekit: "src/instrumentation/livekit/processor.ts",
    },
    format: ["cjs", "esm"],
    outDir: "dist",
    external: ["zod"],
    removeNodeProtocol: false,
    dts: {
      entry: nodeEntries,
      // Split DTS generation to reduce memory usage
      compilerOptions: {
        skipLibCheck: true,
      },
    },
    splitting: true,
    define,
    clean: true,
  },
  // Keep the optional integration's declarations separate from the core API.
  {
    entry: { livekit: "src/instrumentation/livekit/processor.ts" },
    format: ["cjs", "esm"],
    outDir: "dist",
    external: ["zod"],
    removeNodeProtocol: false,
    dts: { only: true, compilerOptions: { skipLibCheck: true } },
    splitting: false,
    define,
    clean: false,
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
  ...(["cjs", "esm"] as const).map((format) => ({
    entry: {
      browser: "src/browser/index.ts",
      "edge-light": "src/edge-light/index.ts",
      workerd: "src/workerd/index.ts",
      "apply-auto-instrumentation.browser":
        "src/non-node/apply-auto-instrumentation-entry.ts",
      ...(format === "esm" ? { "isomorphic-exports": "src/exports.ts" } : {}),
    },
    format: [format],
    outDir: "dist",
    external: ["zod"],
    removeNodeProtocol: false,
    platform: "browser" as const,
    splitting: format === "esm",
    esbuildPlugins:
      format === "esm"
        ? [
            {
              name: "preserve-isomorphic-namespace",
              setup(build: import("esbuild").PluginBuild) {
                // Keep the default namespace as an ESM re-export. Bundling it
                // lowers it to an impure __export() call which retains every
                // API even when consumers only use a named export.
                // Splitting shares logger/isomorph state with the API module.
                const entrypoints = new Set(
                  ["browser", "edge-light", "workerd"].map((runtime) =>
                    resolve(`src/${runtime}/index.ts`),
                  ),
                );
                build.onResolve({ filter: /^\.\.\/exports$/ }, (args) => {
                  if (entrypoints.has(args.importer)) {
                    return {
                      path: "./isomorphic-exports.mjs",
                      external: true,
                    };
                  }
                });
              },
            },
          ]
        : [],
    dts: true,
    define,
    clean: false,
  })),
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
    entry: {
      "bundler/vite": "src/auto-instrumentations/bundler/vite.ts",
      "bundler/webpack": "src/auto-instrumentations/bundler/webpack.ts",
      "bundler/next": "src/auto-instrumentations/bundler/next.ts",
      "bundler/esbuild": "src/auto-instrumentations/bundler/esbuild.ts",
      "bundler/rollup": "src/auto-instrumentations/bundler/rollup.ts",
    },
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
