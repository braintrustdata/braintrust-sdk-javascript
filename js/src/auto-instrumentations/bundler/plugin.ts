import { createUnplugin } from "unplugin";
import { create, type InstrumentationConfig } from "../orchestrion-js";
import { extname, join, sep } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import moduleDetailsFromPath from "module-details-from-path";
import { getDefaultInstrumentationConfigs } from "../configs/all";
import { applySpecialCasePatch } from "../loader/special-case-patches";

export interface LegacyBundlerPluginOptions {
  /**
   * Enable debug logging
   */
  debug?: boolean;

  /**
   * Additional instrumentation configs to apply
   */
  instrumentations?: InstrumentationConfig[];

  /**
   * Whether to bundle for browser environments.
   *
   * This remains as a legacy target hint for special-case patches. Global
   * instrumentation hooks are runtime-independent.
   */
  browser?: boolean;
}

export interface BundlerPluginOptions {
  /**
   * Enable debug logging
   */
  debug?: boolean;

  /**
   * Additional instrumentation configs to apply
   */
  instrumentations?: InstrumentationConfig[];

  /**
   * Legacy browser target hint.
   *
   * Global instrumentation hooks no longer require a diagnostics-channel shim.
   * The option is retained for source compatibility and only controls whether
   * Node-specific special-case patches are skipped.
   *
   * @default false
   */
  useDiagnosticChannelCompatShim?: boolean;
}

/**
 * Helper function to get module version from package.json
 */
function getModuleVersion(basedir: string): string | undefined {
  try {
    const packageJsonPath = join(basedir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson.version) {
      return packageJson.version;
    }
  } catch (error) {
    //
  }

  return undefined; // No version found
}

export const unplugin = createUnplugin<LegacyBundlerPluginOptions>(
  (options = {}) => {
    const allInstrumentations = getDefaultInstrumentationConfigs({
      additionalInstrumentations: options.instrumentations,
    });

    // Create the code transformer instrumentor
    const instrumentationMatcher = create(allInstrumentations);

    return {
      name: "code-transformer",
      enforce: "pre",
      transform(code: string, id: string) {
        if (!id) {
          // Some modules apparently don't have an id?
          return null;
        }

        // Convert file:// URLs to regular paths at entry point
        // Node.js ESM loader hooks provide file:// URLs, but downstream code expects paths
        const filePath = id.startsWith("file:") ? fileURLToPath(id) : id;

        // Determine if this is an ES module using multiple methods for accurate detection
        const ext = extname(filePath);
        let isModule = ext === ".mjs" || ext === ".ts" || ext === ".tsx";

        // For .js files, use content analysis for module detection
        if (ext === ".js") {
          isModule = code.includes("export ") || code.includes("import ");
        }

        // Try to get module details from the file path
        // IMPORTANT: module-details-from-path uses path.sep to split paths.
        // On Windows (path.sep = '\'), we need to convert forward slashes to backslashes.
        // On Unix (path.sep = '/'), paths should already use forward slashes.
        // Some bundlers (like Vite/Rollup) may pass paths with forward slashes even on Windows.
        const normalizedForPlatform = filePath.split("/").join(sep);
        const moduleDetails = moduleDetailsFromPath(normalizedForPlatform);

        // If no module details found, the file is not part of a module
        if (!moduleDetails) {
          return null;
        }

        // Use module details for accurate module information
        const moduleName = moduleDetails.name;
        // Normalize the module path for Windows compatibility (WASM transformer expects forward slashes)
        const normalizedModulePath = moduleDetails.path.replace(/\\/g, "/");
        const moduleVersion = getModuleVersion(moduleDetails.basedir);

        // Per-package source patches (see loader/special-case-patches.ts).
        // Same anti-pattern fallback the runtime loader uses — mirrored here
        // so bundled apps get the patches without relying on hook.mjs.
        // Skipped for browser bundles since the wrapper templates use
        // `node:module`/`require` to resolve `@mastra/observability`.
        if (options.browser !== true) {
          const patched = applySpecialCasePatch({
            packageName: moduleName,
            modulePath: normalizedModulePath,
            source: code,
            format: isModule ? "esm" : "cjs",
          });
          if (patched !== null) {
            return { code: patched, map: null };
          }
        }

        // If no version found
        if (!moduleVersion) {
          console.warn(
            `No 'package.json' version found for module ${moduleName} at ${moduleDetails.basedir}. Skipping transformation.`,
          );
          return null;
        }

        // Try to get a transformer for this file
        const transformer = instrumentationMatcher.getTransformer(
          moduleName,
          moduleVersion,
          normalizedModulePath,
        );

        if (!transformer) {
          // No instrumentations match this file
          return null;
        }

        try {
          // Transform the code
          const moduleType = isModule ? "esm" : "cjs";
          const result = transformer.transform(code, moduleType);
          return {
            code: result.code,
            map: result.map,
          };
        } catch (error) {
          // If transformation fails, warn and return original code
          console.warn(`Code transformation failed for ${id}: ${error}`);
          return null;
        }
      },
    };
  },
);
