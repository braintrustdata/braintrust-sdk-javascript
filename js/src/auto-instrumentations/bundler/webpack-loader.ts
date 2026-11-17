/**
 * Webpack loader for auto-instrumentation.
 *
 * This is a webpack loader (not a plugin) for compatibility with tools that only support loaders,
 * such as Next.js Turbopack.
 *
 * The `braintrust/next` entrypoint resolves this implementation directly when
 * configuring Turbopack; it is not a user-facing package entrypoint.
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
      options.browser ?? false,
    );
    if (result) {
      callback(null, result.code, result.map ?? undefined);
    } else {
      callback(null, code, inputSourceMap);
    }
  } catch (error) {
    debugLogger.notice.warn(
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
