/**
 * Webpack loader for auto-instrumentation.
 *
 * This is a webpack loader (not a plugin) for compatibility with tools that only support loaders,
 * such as Next.js Turbopack.
 *
 * Usage in next.config.js / next.config.ts:
 * ```javascript
 * const nextConfig: NextConfig = {
 *   turbopack: {
 *     rules: {
 *       // Apply the loader to all JS/MJS/CJS files from node_modules.
 *       // condition: "foreign" restricts the rule to third-party packages only.
 *       "*.{js,mjs,cjs}": {
 *         condition: "foreign",
 *         loaders: [{ loader: require.resolve("braintrust/webpack-loader") }],
 *       },
 *     },
 *   },
 * };
 * ```
 */

import { create } from "../orchestrion-js";
import { extname, join, sep } from "path";
import { readFileSync } from "fs";
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
import { type LegacyBundlerPluginOptions } from "./plugin";

const MODULE_EXPORT_ORIGINAL_QUERY = "braintrust-top-level-original";
const disabledIntegrationConfig = readDisabledInstrumentationEnvConfig(
  process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
).integrations;

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

  return undefined;
}

type Matcher = ReturnType<typeof create>;
type ModuleType = "esm" | "cjs";

// Matcher cache keyed by config hash for cache invalidation.
const matcherCache = new Map<string, Matcher>();

/**
 * Get or create a matcher instance, caching by config hash
 */
function getMatcher(options: LegacyBundlerPluginOptions): Matcher {
  const orchestrionConfigs = getDefaultOrchestrionConfigs({
    additionalOrchestrionConfigs: options.instrumentations,
    disabledIntegrationConfig,
  });
  const dcModule = options.browser ? "dc-browser" : undefined;
  const configHash = JSON.stringify({ orchestrionConfigs, dcModule });

  if (matcherCache.has(configHash)) {
    return matcherCache.get(configHash)!;
  }

  for (const hash of matcherCache.keys()) {
    if (hash !== configHash) {
      matcherCache.delete(hash);
    }
  }

  const matcher = create(orchestrionConfigs, dcModule ?? null);
  matcherCache.set(configHash, matcher);
  return matcher;
}

// Cleanup on process exit
process.on("exit", () => {
  matcherCache.clear();
});

/**
 * Webpack loader that instruments JavaScript code using code-transformer.
 *
 * Accepts the same options as the legacy webpack plugin.
 */
function codeTransformerLoader(
  this: any,
  code: string,
  inputSourceMap?: any,
): void {
  const callback = this.async();
  const options: LegacyBundlerPluginOptions = this.getOptions() ?? {};
  const resourcePath: string = this.resourcePath;
  const resourceQuery: string = this.resourceQuery ?? "";

  // Skip virtual modules (e.g. Next.js loaders pass query-string URLs with no real path)
  if (!resourcePath) {
    return callback(null, code, inputSourceMap);
  }
  if (resourceQuery.includes(MODULE_EXPORT_ORIGINAL_QUERY)) {
    return callback(null, code, inputSourceMap);
  }

  // Determine if this is an ES module using multiple methods for accurate detection
  const ext = extname(resourcePath);
  let isModule = ext === ".mjs" || ext === ".ts" || ext === ".tsx";

  // For .js files, use content analysis for module detection
  if (ext === ".js") {
    isModule = code.includes("export ") || code.includes("import ");
  }

  // Try to get module details from the file path
  // IMPORTANT: module-details-from-path uses path.sep to split paths.
  // On Windows (path.sep = '\'), we need to convert forward slashes to backslashes.
  const normalizedForPlatform = resourcePath.split("/").join(sep);
  const moduleDetails = moduleDetailsFromPath(normalizedForPlatform);

  if (!moduleDetails) {
    return callback(null, code, inputSourceMap);
  }

  const moduleName = moduleDetails.name;
  const moduleVersion = getModuleVersion(moduleDetails.basedir);

  // Normalize the module path for Windows compatibility (WASM transformer expects forward slashes)
  const normalizedModulePath = moduleDetails.path.replace(/\\/g, "/");
  const moduleType: ModuleType = isModule ? "esm" : "cjs";
  const target: ModuleExportPatchTarget =
    options.browser === true ? "browser" : "node";
  const moduleExportPatchConfigs = getDefaultModuleExportPatchConfigs({
    disabledIntegrationConfig,
    target,
  });

  let nextCode = code;
  let didPatch = false;

  if (options.browser !== true) {
    const patched = applySourcePatch({
      format: moduleType,
      modulePath: normalizedModulePath,
      packageName: moduleName,
      source: nextCode,
    });
    if (patched !== null) {
      nextCode = patched;
      didPatch = true;
    }
  }

  const moduleExportWrapper = buildModuleExportSourceWrapper(
    moduleExportPatchConfigs,
    {
      format: moduleType,
      modulePath: normalizedModulePath,
      moduleVersion,
      originalModuleSpecifier: `${resourcePath}?${MODULE_EXPORT_ORIGINAL_QUERY}`,
      packageName: moduleName,
      source: nextCode,
      target,
    },
  );
  if (moduleExportWrapper !== null) {
    nextCode = moduleExportWrapper;
    didPatch = true;
  }

  if (!moduleVersion) {
    return callback(null, nextCode, inputSourceMap);
  }

  const matcher = getMatcher(options);
  const transformer = matcher.getTransformer(
    moduleName,
    moduleVersion,
    normalizedModulePath,
  );

  if (!transformer) {
    return callback(null, nextCode, inputSourceMap);
  }

  try {
    const result = transformer.transform(nextCode, moduleType);
    callback(null, result.code, result.map ?? undefined);
  } catch (error) {
    console.warn(
      `[code-transformer-loader] Error transforming ${resourcePath}:`,
      error,
    );
    callback(null, didPatch ? nextCode : code, inputSourceMap);
  }
}

// Attach Options type to the loader function
namespace codeTransformerLoader {
  export type Options = LegacyBundlerPluginOptions;
}

export = codeTransformerLoader;
