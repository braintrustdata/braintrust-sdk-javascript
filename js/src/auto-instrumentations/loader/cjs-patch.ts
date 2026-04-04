/**
 * CJS module patcher for auto-instrumentation.
 * Patches Module.prototype._compile to transform CommonJS modules at load time.
 */

import {
  create,
  type InstrumentationConfig,
} from "@apm-js-collab/code-transformer";
import * as NodeModule from "node:module";
import { sep } from "node:path";
import moduleDetailsFromPath from "module-details-from-path";
import { getPackageName, getPackageVersion } from "./get-package-version.js";

export class ModulePatch {
  private packages: Set<string>;
  private instrumentator: any;
  private modulePrototype: { _compile?: (...args: any[]) => unknown };
  private originalCompile: any;

  constructor({
    instrumentations = [],
  }: { instrumentations?: InstrumentationConfig[] } = {}) {
    const modulePrototype = resolveModulePrototype() as any;

    this.packages = new Set(instrumentations.map((i) => i.module.name));
    this.instrumentator = create(instrumentations);
    this.modulePrototype = modulePrototype;
    this.originalCompile = modulePrototype._compile;
  }

  /**
   * Patches the Node.js module class method that is responsible for compiling code.
   * If a module is found that has an instrumentator, it will transform the code before compiling it
   * with tracing channel methods.
   */
  patch() {
    const self = this;
    this.modulePrototype._compile = function wrappedCompile(...args: any[]) {
      const [content, filename] = args;

      // Normalize path to platform-specific separator for module-details-from-path
      const normalizedForPlatform = filename.split("/").join(sep);

      const resolvedModule = moduleDetailsFromPath(normalizedForPlatform);

      if (resolvedModule) {
        const packageName =
          getPackageName(resolvedModule.basedir) ?? resolvedModule.name;

        if (!self.packages.has(packageName)) {
          return self.originalCompile.apply(this, args);
        }

        const version = getPackageVersion(resolvedModule.basedir);

        // Normalize module path for transformer (expects forward slashes)
        const normalizedModulePath = resolvedModule.path.replace(/\\/g, "/");

        const transformer = self.instrumentator.getTransformer(
          packageName,
          version,
          normalizedModulePath,
        );

        if (transformer) {
          try {
            const transformedCode = transformer.transform(content, "unknown");
            args[0] = transformedCode?.code;
          } catch (error) {
            console.warn(`Error transforming module ${filename}:`, error);
          } finally {
            transformer.free();
          }
        }
      }

      return self.originalCompile.apply(this, args);
    };
  }

  /**
   * Restores the original Module.prototype._compile method
   * **Note**: This is intended to be used in testing only.
   */
  unpatch() {
    this.modulePrototype._compile = this.originalCompile;
  }
}

function resolveModulePrototype():
  | { _compile?: (...args: any[]) => unknown }
  | undefined {
  const moduleCtor = (NodeModule as any).Module;
  if (moduleCtor && typeof moduleCtor === "function") {
    return moduleCtor.prototype as { _compile?: (...args: any[]) => unknown };
  }

  return (NodeModule as any).prototype as
    | { _compile?: (...args: any[]) => unknown }
    | undefined;
}
