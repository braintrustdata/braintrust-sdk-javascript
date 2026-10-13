import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import { build as viteBuild } from "vite";
import type { BundlerPluginOptions } from "../../src/auto-instrumentations/bundler/plugin";

export const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));

export type Bundler = "esbuild" | "vite" | "rollup";

/**
 * Bundles a fixture entry (which imports packages from fixtures/node_modules)
 * with the Braintrust plugin for the given bundler and writes an ESM bundle to
 * `outfile`.
 */
export async function bundleFixture(
  bundler: Bundler,
  entryPoint: string,
  outfile: string,
  options: BundlerPluginOptions = {},
): Promise<void> {
  if (bundler === "esbuild") {
    const { braintrustEsbuildPlugin } =
      await import("../../src/auto-instrumentations/bundler/esbuild.js");
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      write: true,
      outfile,
      format: "esm",
      plugins: [braintrustEsbuildPlugin(options)],
      logLevel: "error",
      absWorkingDir: fixturesDir,
      preserveSymlinks: true, // Don't dereference symlinks
      platform: "node",
    });
  } else if (bundler === "vite") {
    const { braintrustVitePlugin } =
      await import("../../src/auto-instrumentations/bundler/vite.js");
    await viteBuild({
      root: fixturesDir,
      build: {
        lib: {
          entry: entryPoint,
          formats: ["es"],
          fileName: path.basename(outfile, ".mjs"),
        },
        outDir: path.dirname(outfile),
        emptyOutDir: false,
        minify: false,
      },
      plugins: [braintrustVitePlugin(options)],
      logLevel: "error",
      resolve: { preserveSymlinks: true },
    });
  } else {
    const { braintrustRollupPlugin } =
      await import("../../src/auto-instrumentations/bundler/rollup.js");
    const bundle = await rollup({
      input: entryPoint,
      plugins: [
        {
          name: "resolve-fixture-packages",
          resolveId(source: string) {
            // Bundler resolveId always returns posix-style paths
            return source.startsWith("openai")
              ? path
                  .resolve(fixturesDir, "node_modules", source)
                  .replace(/\\/g, "/")
              : null;
          },
        },
        braintrustRollupPlugin(options),
      ],
      preserveSymlinks: true,
    });
    await bundle.write({ file: outfile, format: "es" });
    await bundle.close();
  }
}
