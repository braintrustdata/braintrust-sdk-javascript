import { debugLogger } from "../../debug-logger";
import { createUnplugin } from "unplugin";
import { InstrumentationMatcher } from "../orchestrion-js";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultAutoInstrumentationConfigs } from "../configs/all";
import { transformBundledModule } from "./transform";

export interface BundlerPluginOptions {
  /**
   * Whether the transformed source will run in a browser or edge-like
   * environment.
   *
   * Global instrumentation hooks are runtime-independent. This option only
   * prevents the Node-specific Mastra source patch from entering the bundle.
   *
   * @default false
   */
  browser?: boolean;

  /**
   * Marks transformed source as targeting a browser or edge-like environment.
   *
   * This retains the previous browser-target behavior of the option. Global
   * instrumentation hooks are runtime-independent, so no diagnostics-channel
   * compatibility shim is injected.
   *
   * @deprecated Use `browser` instead.
   */
  useDiagnosticChannelCompatShim?: boolean;
}

export const unplugin = createUnplugin<BundlerPluginOptions>((options = {}) => {
  const browser =
    options.browser ?? options.useDiagnosticChannelCompatShim ?? false;
  const matcher = new InstrumentationMatcher(
    getDefaultAutoInstrumentationConfigs(),
  );

  return {
    name: "code-transformer",
    enforce: "pre",
    transformInclude(id: string) {
      const pathWithoutQuery = id.split("?", 1)[0];
      if (!pathWithoutQuery) {
        return false;
      }
      if (pathWithoutQuery.startsWith("file:")) {
        try {
          return isAbsolute(fileURLToPath(pathWithoutQuery));
        } catch {
          return false;
        }
      }
      return isAbsolute(pathWithoutQuery);
    },
    transform(code: string, id: string) {
      if (!id) {
        // Some modules apparently don't have an id?
        return null;
      }

      // Vite and Rollup may append cache-busting queries or fragments to
      // real filesystem module IDs. They are not part of the package path
      // and prevent exact instrumentation file paths from matching.
      const cleanId = id.replace(/[?#].*$/, "");

      // Convert file:// URLs to regular paths at entry point
      // Node.js ESM loader hooks provide file:// URLs, but downstream code expects paths
      const filePath = cleanId.startsWith("file:")
        ? fileURLToPath(cleanId)
        : cleanId;

      try {
        return transformBundledModule(code, filePath, matcher, browser);
      } catch (error) {
        // If transformation fails, warn and return original code
        debugLogger.notice.warn(
          `Code transformation failed for ${id}: ${error}`,
        );
        return null;
      }
    },
  };
});
