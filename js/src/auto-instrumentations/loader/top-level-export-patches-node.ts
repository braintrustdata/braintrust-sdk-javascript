import * as module from "node:module";
import { debugLogger } from "../../debug-logger";
import {
  createHook as createImportInTheMiddleHook,
  supportsSyncHooks,
  type ImportInTheMiddleHook as ImportInTheMiddleHookApi,
} from "../import-in-the-middle/create-hook.mjs";
import ImportInTheMiddleRuntimeHook from "./import-in-the-middle-runtime.js";
import RequireInTheMiddleHook from "./require-in-the-middle-runtime.js";
import {
  getTopLevelImportHookSpecifiers,
  runTopLevelImportHooks,
  type TopLevelImportHook,
} from "./top-level-export-patches.js";

export interface InstallNodeTopLevelExportPatchesOptions {
  hooks: readonly TopLevelImportHook[];
  asyncImportHookUrl: string;
  registryImportUrl: string;
  runtime?: Partial<NodeTopLevelExportPatchRuntime>;
}

type HookCallback = (
  exportsValue: unknown,
  name: string,
  baseDir?: string,
) => unknown;

type HookConstructor = new (modules: string[], hookFn: HookCallback) => unknown;

interface NodeModuleApi {
  register: (specifier: string, options?: unknown) => void;
  registerHooks?: (hooks: { load: unknown; resolve: unknown }) => void;
}

export interface NodeTopLevelExportPatchRuntime {
  createImportHook: (
    meta: { url: string },
    options: { registerUrl: string },
  ) => ImportInTheMiddleHookApi;
  importHookConstructor: HookConstructor;
  moduleApi: NodeModuleApi;
  requireHookConstructor: HookConstructor;
  supportsSyncHooks: () => boolean;
}

export function installNodeTopLevelExportPatches({
  asyncImportHookUrl,
  hooks,
  registryImportUrl,
  runtime,
}: InstallNodeTopLevelExportPatchesOptions): void {
  const specifiers = getTopLevelImportHookSpecifiers(hooks);
  if (specifiers.length === 0) return;

  const effectiveRuntime = getRuntime(runtime);
  const hookCallback: HookCallback = (exportsValue, name, baseDir) =>
    runTopLevelImportHooks(hooks, exportsValue, {
      baseDir,
      moduleName: name,
    });

  try {
    if (
      effectiveRuntime.moduleApi.registerHooks &&
      effectiveRuntime.supportsSyncHooks()
    ) {
      const importHook = effectiveRuntime.createImportHook(
        { url: registryImportUrl },
        { registerUrl: registryImportUrl },
      );
      void importHook.initialize({ include: specifiers });
      effectiveRuntime.moduleApi.registerHooks({
        load: importHook.loadSync,
        resolve: importHook.resolveSync,
      });
    } else {
      effectiveRuntime.moduleApi.register(asyncImportHookUrl, {
        data: { include: specifiers },
      });
    }

    new effectiveRuntime.importHookConstructor(specifiers, hookCallback);
  } catch (err) {
    debugLogger.warn("Failed to install ESM top-level import hooks", err);
  }

  try {
    new effectiveRuntime.requireHookConstructor(specifiers, hookCallback);
  } catch (err) {
    debugLogger.warn("Failed to install CJS top-level import hooks", err);
  }
}

function getRuntime(
  overrides: Partial<NodeTopLevelExportPatchRuntime> | undefined,
): NodeTopLevelExportPatchRuntime {
  return {
    createImportHook: createImportInTheMiddleHook,
    importHookConstructor:
      ImportInTheMiddleRuntimeHook as unknown as HookConstructor,
    moduleApi: module as unknown as NodeModuleApi,
    requireHookConstructor:
      RequireInTheMiddleHook as unknown as HookConstructor,
    supportsSyncHooks,
    ...overrides,
  };
}
