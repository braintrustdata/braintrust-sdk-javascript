/**
 * CJS module patcher for auto-instrumentation.
 * Patches Module.prototype._compile to transform CommonJS modules at load time.
 */

import { debugLogger } from "../../debug-logger";

import {
  InstrumentationMatcher,
  type InstrumentationConfig,
} from "../orchestrion-js";
import { Module } from "node:module";
import { sep } from "node:path";
import moduleDetailsFromPath from "module-details-from-path";
import { getPackageInfo } from "./get-package-info.js";
import { applySpecialCasePatch } from "./special-case-patches.js";

export function patchCommonJS(instrumentations: InstrumentationConfig[]): void {
  const matcher = new InstrumentationMatcher(instrumentations);
  const prototype = Module.prototype as Module & {
    _compile(
      this: Module,
      source: string,
      filename: string,
      ...options: unknown[]
    ): unknown;
  };
  const originalCompile = prototype._compile;
  prototype._compile = function (source, filename, ...options) {
    const resolvedModule = moduleDetailsFromPath(filename.split("/").join(sep));
    if (resolvedModule) {
      const packageInfo = getPackageInfo(resolvedModule.basedir);
      const packageName = packageInfo?.name ?? resolvedModule.name;
      const modulePath = resolvedModule.path.replace(/\\/g, "/");
      const patched = applySpecialCasePatch({
        packageName,
        modulePath,
        source,
        format: "cjs",
      });
      if (patched !== null) {
        source = patched;
      } else if (packageInfo?.version) {
        const transformer = matcher.getTransformer(
          packageName,
          packageInfo.version,
          modulePath,
        );
        if (transformer) {
          try {
            source = transformer.transform(source, "unknown").code;
          } catch (error) {
            debugLogger.notice.warn(
              `Error transforming module ${filename}:`,
              error,
            );
          }
        }
      }
    }
    return originalCompile.call(this, source, filename, ...options);
  };
}
