import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import type { PackUserConfig } from "vite-plus/pack";
import { readFileSync } from "node:fs";

const __dirname = import.meta.dirname;

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
const define = { __BRAINTRUST_SDK_VERSION__: JSON.stringify(pkg.version) };
const common = {
  sourcemap: true,
  // Clean the whole package output, including obsolete runtime directories.
  clean: ["dist"],
  fixedExtension: false,
  define,
  dts: { generator: "oxc" as const },
  deps: {
    onlyBundle: ["async"],
  },
};
const entries = {
  index: "src/exports.ts",
  instrumentation: "src/instrumentation/index.ts",
  "custom-views": "src/custom-views/exports.ts",
  preprocessors: "src/preprocessors/exports.ts",
  auto: "src/auto.ts",
};

export default defineConfig({
  // Prefer TypeScript over JavaScript for extension-less imports in sdk/js tests
  resolve: {
    tsconfigPaths: true,
    extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx", ".json"],
    alias: {
      "#braintrust-platform": path.resolve(__dirname, "src/isomorph.ts"),
      "@apm-js-collab/code-transformer": path.resolve(
        __dirname,
        "src/auto-instrumentations/orchestrion-js/index.ts",
      ),
    },
  },
  server: {
    watch: {
      ignored: [
        "**/node_modules/**",
        "**/dist/**",
        "**/vendor/**",
        "**/.{idea,git,cache,output,temp}/**",
      ],
    },
    fs: {
      // Deny access to vendor folder
      deny: [path.resolve(__dirname, "vendor")],
    },
  },
  optimizeDeps: {
    exclude: ["vendor/**"],
  },
  test: {
    reporters: ["default"],
    exclude: [
      // Default vitest exclusions
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      // Exclude vendor folder and all its contents
      "**/vendor/**",
      "vendor/**",
      "./vendor/**",
      // Exclude subdirectories with their own test configs
      "src/wrappers/ai-sdk/**",
      "src/wrappers/claude-agent-sdk/**",
      "src/wrappers/vitest/**",
      "smoke/**",
      // Exclude example tests (require API keys and make real API calls)
      "examples/vitest/**",
      "examples/node-test/**",
    ],
    testTimeout: 15_000,
  },
  run: {
    tasks: {
      compile: {
        command: "vp pack",
        dependsOn: [
          { task: "compile", from: ["dependencies", "devDependencies"] },
        ],
        cache: {
          input: [{ auto: true }, "!dist/**"],
          untrackedEnv: ["SHELL", "BASH_ENV"],
          output: ["dist/**"],
        },
      },
    },
  },
  pack: [
    ...(["node", "browser", "workerd", "edge-light"] as const).map(
      (runtime): PackUserConfig => ({
        ...common,
        name: runtime,
        // Preserve internal module boundaries so consumers can discard unused
        // features through the root export without public feature subpaths.
        unbundle: true,
        outputOptions: {
          // Keep bundled dependencies inside our ESM package scope. A nested
          // node_modules directory makes loaders treat them as another package.
          sanitizeFileName: (name) =>
            name
              .replaceAll("\0", "_")
              .replaceAll("node_modules", "_vendor")
              .replaceAll(".pnpm", "_pnpm"),
        },
        dts: {
          generator: "oxc",
          compilerOptions: {
            paths: { "#braintrust-platform": [`./src/${runtime}/isomorph.ts`] },
          },
        },
        ...(runtime === "node"
          ? {}
          : { platform: "browser" as const, target: "es2022" }),
        outDir: `dist/${runtime}`,
        entry: {
          ...entries,
          "apply-auto-instrumentation":
            runtime === "node"
              ? "src/node/apply-auto-instrumentation-entry.ts"
              : "src/non-node/apply-auto-instrumentation-entry.ts",
          ...(runtime === "node"
            ? {
                "vitest-evals-reporter":
                  "src/wrappers/vitest-evals/reporter.ts",
              }
            : {}),
        },
        // Resolve before tsconfig paths: Pack's ordinary alias option loses to
        // the source-test fallback and would put Node adapters in browser builds.
        plugins: [
          {
            name: "braintrust-platform",
            resolveId: {
              order: "pre",
              handler(id) {
                if (id === "#braintrust-platform")
                  return fileURLToPath(
                    new URL(`./src/${runtime}/isomorph.ts`, import.meta.url),
                  );
              },
            },
          },
        ],
      }),
    ),
    {
      ...common,
      name: "tooling",
      outDir: "dist/tooling",
      entry: Object.fromEntries(
        [
          "bundler/vite",
          "bundler/webpack",
          "bundler/next",
          "bundler/esbuild",
          "bundler/rollup",
        ].map((name) => [name, `src/auto-instrumentations/${name}.ts`]),
      ),
    },
    {
      ...common,
      name: "loader",
      format: "cjs",
      dts: false,
      outDir: "dist/loaders",
      entry: {
        "webpack-loader": "src/auto-instrumentations/bundler/webpack-loader.ts",
      },
    },
    {
      ...common,
      name: "hooks",
      dts: false,
      outDir: "dist/hooks",
      entry: {
        hook: "src/auto-instrumentations/hook.mts",
        "loader/module-hooks":
          "src/auto-instrumentations/loader/module-hooks.mts",
      },
      fixedExtension: true,
      deps: { neverBundle: ["../auto.js"] },
      outputOptions: {
        paths: {
          [fileURLToPath(new URL("./src/auto.js", import.meta.url))]:
            "../node/auto.js",
        },
      },
    },
  ],
});
