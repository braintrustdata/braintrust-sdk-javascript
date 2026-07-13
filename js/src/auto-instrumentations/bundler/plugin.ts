import { createUnplugin } from "unplugin";
import { create, type InstrumentationConfig } from "../orchestrion-js";
import { dirname, extname, join, resolve, sep } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import moduleDetailsFromPath from "module-details-from-path";
import {
  getDefaultModuleExportPatchConfigs,
  getDefaultOrchestrionConfigs,
} from "../configs/all";
import { applySourcePatch } from "../loader/source-patches";
import {
  buildModuleExportSourceWrapper,
  type ModuleExportPatchTarget,
} from "../loader/module-hooks/registry";
import { readDisabledInstrumentationEnvConfig } from "../../instrumentation/config";

const MODULE_EXPORT_ORIGINAL_IMPORT_PREFIX = "braintrust-top-level-original:";
const MODULE_EXPORT_ORIGINAL_RESOLVED_PREFIX = `\0${MODULE_EXPORT_ORIGINAL_IMPORT_PREFIX}`;

export interface LegacyBundlerPluginOptions {
  /**
   * Enable debug logging
   */
  debug?: boolean;

  /**
   * Additional Orchestrion configs to apply
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
   * Additional Orchestrion configs to apply
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
    const disabledIntegrationConfig = readDisabledInstrumentationEnvConfig(
      process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
    ).integrations;
    const orchestrionConfigs = getDefaultOrchestrionConfigs({
      additionalOrchestrionConfigs: options.instrumentations,
      disabledIntegrationConfig,
    });
    const moduleExportPatchTarget: ModuleExportPatchTarget =
      options.browser === false ? "node" : "browser";
    const moduleExportPatchConfigs = getDefaultModuleExportPatchConfigs({
      disabledIntegrationConfig,
      target: moduleExportPatchTarget,
    });
    const originalSources = new Map<string, string>();
    const originalDirectories = new Map<string, string>();
    let nextOriginalId = 0;

    // Default to browser build, use polyfill unless explicitly disabled
    const dcModule = options.browser === false ? undefined : "dc-browser";

    // Create the code transformer instrumentor
    const instrumentationMatcher = create(orchestrionConfigs, dcModule);

    return {
      name: "code-transformer",
      enforce: "pre",
      resolveId(id: string, importer?: string) {
        if (id.startsWith(MODULE_EXPORT_ORIGINAL_IMPORT_PREFIX)) {
          return `${MODULE_EXPORT_ORIGINAL_RESOLVED_PREFIX}${id.slice(
            MODULE_EXPORT_ORIGINAL_IMPORT_PREFIX.length,
          )}`;
        }
        if (
          id.startsWith(".") &&
          importer?.startsWith(MODULE_EXPORT_ORIGINAL_RESOLVED_PREFIX)
        ) {
          const originalDirectory = originalDirectories.get(importer);
          if (originalDirectory) {
            return resolve(originalDirectory, id);
          }
        }
        return null;
      },
      load(id: string) {
        if (id.startsWith(MODULE_EXPORT_ORIGINAL_RESOLVED_PREFIX)) {
          return originalSources.get(id) ?? null;
        }
        return null;
      },
      transform(code: string, id: string) {
        if (!id) {
          // Some modules apparently don't have an id?
          return null;
        }
        if (id.startsWith(MODULE_EXPORT_ORIGINAL_RESOLVED_PREFIX)) {
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
        const moduleType = isModule ? "esm" : "cjs";
        let nextCode = code;
        let didPatch = false;

        // Per-package source patches (see loader/source-patches/).
        // Same anti-pattern fallback the runtime loader uses — mirrored here
        // so bundled apps get the patches without relying on hook.mjs.
        if (options.browser !== true) {
          const patched = applySourcePatch({
            packageName: moduleName,
            modulePath: normalizedModulePath,
            source: nextCode,
            format: moduleType,
          });
          if (patched !== null) {
            nextCode = patched;
            didPatch = true;
          }
        }

        const originalModuleSpecifier = `${MODULE_EXPORT_ORIGINAL_IMPORT_PREFIX}${nextOriginalId++}`;
        const originalModuleId = `${MODULE_EXPORT_ORIGINAL_RESOLVED_PREFIX}${originalModuleSpecifier.slice(
          MODULE_EXPORT_ORIGINAL_IMPORT_PREFIX.length,
        )}`;
        const moduleExportWrapper = buildModuleExportSourceWrapper(
          moduleExportPatchConfigs,
          {
            format: moduleType,
            modulePath: normalizedModulePath,
            moduleVersion,
            originalModuleSpecifier,
            packageName: moduleName,
            source: nextCode,
            target: moduleExportPatchTarget,
          },
        );
        if (moduleExportWrapper !== null) {
          originalSources.set(originalModuleId, nextCode);
          originalDirectories.set(originalModuleId, dirname(filePath));
          nextCode = moduleExportWrapper;
          didPatch = true;
        }

        // If no version found
        if (!moduleVersion) {
          if (didPatch) {
            return { code: nextCode, map: null };
          }
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
          return didPatch ? { code: nextCode, map: null } : null;
        }

        try {
          // Transform the code
          const result = transformer.transform(nextCode, moduleType);
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
          return didPatch ? { code: nextCode, map: null } : null;
        }
      },
    };
  },
);
