import { createUnplugin } from "unplugin";
import {
  create,
  type InstrumentationConfig,
} from "@apm-js-collab/code-transformer";
import { extname, join, sep } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import moduleDetailsFromPath from "module-details-from-path";
import { getDefaultInstrumentationConfigs } from "../configs/all";

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
   * When true, uses 'dc-browser' for browser-compatible diagnostics_channel polyfill.
   * When false, uses Node.js built-in 'diagnostics_channel' and 'async_hooks'.
   * Defaults to true (assumes browser build).
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
   * Use the `diagnostics_channel` compatibility shim in patched code instead
   * of Node.js's built-in `diagnostics_channel` module.
   *
   * Enable this for browser, edge, or worker bundles where Node's
   * `diagnostics_channel` module is unavailable. Leave it disabled for Node.js
   * bundles so transformed SDK code publishes on the native `diagnostics_channel`
   * registry.
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

    // Default to browser build, use polyfill unless explicitly disabled
    const dcModule = options.browser === false ? undefined : "dc-browser";

    // Create the code transformer instrumentor
    const instrumentationMatcher = create(allInstrumentations, dcModule);

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
        const moduleVersion = getModuleVersion(moduleDetails.basedir);

        // If no version found
        if (!moduleVersion) {
          console.warn(
            `No 'package.json' version found for module ${moduleName} at ${moduleDetails.basedir}. Skipping transformation.`,
          );
          return null;
        }

        // Try to get a transformer for this file
        // Normalize the module path for Windows compatibility (WASM transformer expects forward slashes)
        const normalizedModulePath = moduleDetails.path.replace(/\\/g, "/");
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
          const transformedCode = result.code.replace(
            /const \{tracingChannel: ([A-Za-z_$][\w$]*)\} = ([A-Za-z_$][\w$]*);/g,
            "const $1 = $2.tracingChannel;",
          );

          return {
            code: transformedCode,
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
