import { defineConfig } from "tsup";

export default defineConfig([
  // Node.js entrypoint
  {
    entry: ["src/node/index.ts"],
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
    clean: true,
  },
  // Browser/edge entrypoints
  {
    entry: {
      browser: "src/browser/index.ts",
      "edge-light": "src/edge-light/index.ts",
      workerd: "src/workerd/index.ts",
    },
    format: ["cjs", "esm"],
    outDir: "dist",
    external: ["zod"],
    removeNodeProtocol: false,
    platform: "browser",
    splitting: false,
    dts: true,
    clean: false,
  },
  {
    entry: ["src/instrumentation/index.ts"],
    format: ["cjs", "esm"],
    outDir: "dist/instrumentation",
    external: ["dc-browser", "@braintrust/instrumentation-core", "zod"],
    dts: {
      compilerOptions: {
        skipLibCheck: true,
      },
    },
    splitting: false,
    clean: true,
  },
  {
    entry: [
      "src/auto-instrumentations/index.ts",
      "src/auto-instrumentations/loader/cjs-patch.ts",
      "src/auto-instrumentations/loader/get-package-version.ts",
      "src/auto-instrumentations/bundler/vite.ts",
      "src/auto-instrumentations/bundler/webpack.ts",
      "src/auto-instrumentations/bundler/esbuild.ts",
      "src/auto-instrumentations/bundler/rollup.ts",
    ],
    format: ["cjs", "esm"],
    outDir: "dist/auto-instrumentations",
    dts: true,
    external: ["@apm-js-collab/code-transformer", "zod"],
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
    external: ["@apm-js-collab/code-transformer", "zod"],
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
    external: ["@apm-js-collab/code-transformer", "@anthropic-ai/sdk", "zod"],
    outExtension({ format }) {
      return { js: ".mjs" };
    },
    clean: false,
  },
]);
