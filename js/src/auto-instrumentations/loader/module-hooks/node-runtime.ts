import * as diagnosticsChannel from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  ModuleExportConstructorEvent,
  ModuleExportPatchRuntime,
} from "./registry.js";

export const nodeModuleExportPatchRuntime: ModuleExportPatchRuntime = {
  resolveModule(specifier, context) {
    try {
      return createRequire(
        context.resolutionBase ??
          (context.baseDir
            ? join(context.baseDir, "package.json")
            : join(process.cwd(), "package.json")),
      )(specifier);
    } catch {
      return undefined;
    }
  },
  traceConstructor(channelName, event, construct) {
    return diagnosticsChannel
      .tracingChannel<ModuleExportConstructorEvent>(channelName)
      .traceSync(construct, event);
  },
};
