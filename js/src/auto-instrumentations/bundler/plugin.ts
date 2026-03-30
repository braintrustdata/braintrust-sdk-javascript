/**
 * Shared plugin implementation for auto-instrumentation across bundlers.
 *
 * This module contains the common logic used by all bundler-specific plugins
 * (webpack, rollup, esbuild, vite). Each bundler exports a thin wrapper that
 * uses this shared implementation.
 *
 * This plugin uses @apm-js-collab/code-transformer to perform AST transformation
 * at build-time, injecting TracingChannel calls into AI SDK functions.
 *
 * For browser builds, the plugin automatically uses 'dc-browser' for diagnostics_channel polyfill.
 */

import { createUnplugin } from "unplugin";
import {
  create,
  type InstrumentationConfig,
} from "@apm-js-collab/code-transformer";
import { extname, join, sep } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import moduleDetailsFromPath from "module-details-from-path";
import { openaiConfigs } from "../configs/openai";
import { anthropicConfigs } from "../configs/anthropic";
import { aiSDKConfigs } from "../configs/ai-sdk";
import { claudeAgentSDKConfigs } from "../configs/claude-agent-sdk";
import { googleGenAIConfigs } from "../configs/google-genai";
import { openRouterConfigs } from "../configs/openrouter";

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
   * Whether to bundle for browser environments.
   *
   * When true, uses 'dc-browser' for browser-compatible diagnostics_channel polyfill.
   * When false, uses Node.js built-in 'diagnostics_channel' and 'async_hooks'.
   * Defaults to true (assumes browser build).
   */
  browser?: boolean;
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

export const unplugin = createUnplugin<BundlerPluginOptions>((options = {}) => {
  const allInstrumentations = [
    ...openaiConfigs,
    ...anthropicConfigs,
    ...aiSDKConfigs,
    ...claudeAgentSDKConfigs,
    ...googleGenAIConfigs,
    ...openRouterConfigs,
    ...(options.instrumentations || []),
  ];

  // Default to browser build, use polyfill unless explicitly disabled
  const dcModule = options.browser === false ? undefined : "dc-browser";

  // Create the code transformer instrumentor
  const instrumentationMatcher = create(allInstrumentations, dcModule);

  return {
    name: "code-transformer",
    enforce: "pre",
    transform(code: string, id: string) {
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
});
