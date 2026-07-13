import * as module from "node:module";
import { debugLogger } from "../../../debug-logger";
import {
  createHook as createImportInTheMiddleHook,
  type ImportInTheMiddleHook as ImportInTheMiddleHookApi,
} from "../../import-in-the-middle/create-hook.mjs";
import { supportsSyncHooks } from "../../import-in-the-middle/supports-sync-hooks.mjs";
import ImportInTheMiddleRuntimeHook from "./iitm.js";
import RequireInTheMiddleHook from "./ritm.js";
import { getPackageVersionIfAvailable } from "../package-version.js";
import { nodeModuleExportPatchRuntime } from "./node-runtime.js";
import {
  getModuleExportPatchSpecifiers,
  runModuleExportPatches,
  type ModuleExportPatchConfig,
  type ModuleExportPatchRuntime,
} from "./registry.js";

export interface InstallNodeModuleExportHooksOptions {
  configs: readonly ModuleExportPatchConfig[];
  asyncImportHookUrl: string;
  registryImportUrl: string;
  runtime?: Partial<NodeModuleExportHookRuntime>;
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

export interface NodeModuleExportHookRuntime {
  createImportHook: (
    meta: { url: string },
    options: { registerUrl: string },
  ) => ImportInTheMiddleHookApi;
  importHookConstructor: HookConstructor;
  moduleApi: NodeModuleApi;
  patchRuntime: ModuleExportPatchRuntime;
  requireHookConstructor: HookConstructor;
  supportsSyncHooks: () => boolean;
  getPackageVersion: (baseDir: string) => string | undefined;
}

export function installNodeModuleExportHooks({
  asyncImportHookUrl,
  configs,
  registryImportUrl,
  runtime,
}: InstallNodeModuleExportHooksOptions): void {
  const specifiers = getModuleExportPatchSpecifiers(configs);
  if (specifiers.length === 0) return;

  const effectiveRuntime = getRuntime(runtime);
  const hookCallback: HookCallback = (exportsValue, name, baseDir) =>
    runModuleExportPatches(
      configs,
      exportsValue,
      {
        baseDir,
        moduleName: name,
        moduleVersion: baseDir
          ? effectiveRuntime.getPackageVersion(baseDir)
          : undefined,
      },
      effectiveRuntime.patchRuntime,
    );

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
    debugLogger.warn("Failed to install ESM module export hooks", err);
  }

  try {
    new effectiveRuntime.requireHookConstructor(specifiers, hookCallback);
  } catch (err) {
    debugLogger.warn("Failed to install CJS module export hooks", err);
  }
}

function getRuntime(
  overrides: Partial<NodeModuleExportHookRuntime> | undefined,
): NodeModuleExportHookRuntime {
  return {
    createImportHook: createImportInTheMiddleHook,
    getPackageVersion: getPackageVersionIfAvailable,
    importHookConstructor:
      ImportInTheMiddleRuntimeHook as unknown as HookConstructor,
    moduleApi: module as unknown as NodeModuleApi,
    patchRuntime: nodeModuleExportPatchRuntime,
    requireHookConstructor:
      RequireInTheMiddleHook as unknown as HookConstructor,
    supportsSyncHooks,
    ...overrides,
  };
}
