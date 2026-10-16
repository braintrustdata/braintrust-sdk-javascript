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

import { debugLogger } from "../../debug-logger";

import { InstrumentationMatcher } from "../orchestrion-js";
import { getDefaultAutoInstrumentationConfigs } from "../configs/all";
import { type BundlerPluginOptions } from "./plugin";
import { transformBundledModule } from "./transform";

let cachedMatcher:
  | {
      disabledIntegrations: string | undefined;
      matcher: InstrumentationMatcher;
    }
  | undefined;

function getMatcher(): InstrumentationMatcher {
  const disabledIntegrations = process.env.BRAINTRUST_DISABLE_INSTRUMENTATION;
  if (
    !cachedMatcher ||
    cachedMatcher.disabledIntegrations !== disabledIntegrations
  ) {
    cachedMatcher = {
      disabledIntegrations,
      matcher: new InstrumentationMatcher(
        getDefaultAutoInstrumentationConfigs(),
      ),
    };
  }
  return cachedMatcher.matcher;
}

/**
 * Webpack loader that instruments JavaScript code using code-transformer.
 *
 * Accepts the same options as the Braintrust bundler plugins.
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

  try {
    const result = transformBundledModule(
      code,
      resourcePath,
      getMatcher(),
      options.browser ?? options.useDiagnosticChannelCompatShim ?? false,
    );
    if (result) {
      callback(null, result.code, result.map ?? undefined);
    } else {
      callback(null, code, inputSourceMap);
    }
  } catch (error) {
    debugLogger.warn(
      `[code-transformer-loader] Error transforming ${resourcePath}:`,
      error,
    );
    callback(null, code, inputSourceMap);
  }
}

// Attach Options type to the loader function
namespace codeTransformerLoader {
  export type Options = BundlerPluginOptions;
}

export = codeTransformerLoader;
