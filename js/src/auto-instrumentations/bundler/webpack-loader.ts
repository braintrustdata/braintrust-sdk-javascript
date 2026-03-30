/**
 * Webpack loader for auto-instrumentation.
 *
 * This is a webpack loader (not a plugin) for compatibility with tools that only support loaders,
 * such as Next.js Turbopack. Unlike the other exports in this package, this does not use unplugin.
 *
 * Usage in next.config.js / next.config.ts:
 * ```javascript
 * export default {
 *   webpack(config) {
 *     config.module.rules.unshift({
 *       use: [{ loader: 'braintrust/webpack-loader' }],
 *     });
 *     return config;
 *   },
 * };
 * ```
 *
 * For browser builds, the loader automatically uses 'dc-browser' for diagnostics_channel polyfill.
 */

import {
  create,
  type InstrumentationMatcher,
  type ModuleType,
} from "@apm-js-collab/code-transformer";
import { extname, join, sep } from "path";
import { readFileSync } from "fs";
import moduleDetailsFromPath from "module-details-from-path";
import { openaiConfigs } from "../configs/openai";
import { anthropicConfigs } from "../configs/anthropic";
import { aiSDKConfigs } from "../configs/ai-sdk";
import { claudeAgentSDKConfigs } from "../configs/claude-agent-sdk";
import { googleGenAIConfigs } from "../configs/google-genai";
import { openRouterConfigs } from "../configs/openrouter";
import { type BundlerPluginOptions } from "./plugin";

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

// Matcher cache keyed by config hash for cache invalidation
const matcherCache = new Map<string, InstrumentationMatcher>();

/**
 * Get or create a matcher instance, caching by config hash
 */
function getMatcher(options: BundlerPluginOptions): InstrumentationMatcher {
  const allInstrumentations = [
    ...openaiConfigs,
    ...anthropicConfigs,
    ...aiSDKConfigs,
    ...claudeAgentSDKConfigs,
    ...googleGenAIConfigs,
    ...openRouterConfigs,
    ...(options.instrumentations ?? []),
  ];
  const dcModule = options.browser ? "dc-browser" : undefined;
  const configHash = JSON.stringify({ allInstrumentations, dcModule });

  if (matcherCache.has(configHash)) {
    return matcherCache.get(configHash)!;
  }

  // Free old matchers to prevent memory leaks
  for (const [hash, matcher] of matcherCache.entries()) {
    if (hash !== configHash) {
      matcher.free();
      matcherCache.delete(hash);
    }
  }

  const matcher = create(allInstrumentations, dcModule ?? null);
  matcherCache.set(configHash, matcher);
  return matcher;
}

// Cleanup on process exit
process.on("exit", () => {
  for (const matcher of matcherCache.values()) {
    matcher.free();
  }
  matcherCache.clear();
});

/**
 * Webpack loader that instruments JavaScript code using code-transformer.
 *
 * Accepts the same options as the webpack plugin (BundlerPluginOptions).
 */
function codeTransformerLoader(
  this: any,
  code: string,
  inputSourceMap?: any,
): void {
  const callback = this.async();
  const options: BundlerPluginOptions = this.getOptions() ?? {};
  const resourcePath: string = this.resourcePath;

  // Skip virtual modules (e.g. Next.js loaders pass query-string URLs with no real path)
  if (!resourcePath) {
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

  if (!moduleVersion) {
    return callback(null, code, inputSourceMap);
  }

  // Normalize the module path for Windows compatibility (WASM transformer expects forward slashes)
  const normalizedModulePath = moduleDetails.path.replace(/\\/g, "/");

  const matcher = getMatcher(options);
  const transformer = matcher.getTransformer(
    moduleName,
    moduleVersion,
    normalizedModulePath,
  );

  if (!transformer) {
    return callback(null, code, inputSourceMap);
  }

  try {
    const moduleType: ModuleType = isModule ? "esm" : "cjs";
    const result = transformer.transform(code, moduleType);
    callback(null, result.code, result.map ?? undefined);
  } catch (error) {
    console.warn(
      `[code-transformer-loader] Error transforming ${resourcePath}:`,
      error,
    );
    callback(null, code, inputSourceMap);
  } finally {
    transformer.free();
  }
}

// Attach Options type to the loader function
namespace codeTransformerLoader {
  export type Options = BundlerPluginOptions;
}

export = codeTransformerLoader;
