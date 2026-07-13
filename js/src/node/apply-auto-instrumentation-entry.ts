import * as diagnostics_channel from "node:diagnostics_channel";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import {
  getDefaultModuleExportPatchConfigs,
  getDefaultOrchestrionConfigs,
} from "../auto-instrumentations/configs/all";
import { ModulePatch } from "../auto-instrumentations/loader/cjs";
import { nodeModuleExportPatchRuntime } from "../auto-instrumentations/loader/module-hooks/node-runtime";
import { installModuleExportPatchRunner } from "../auto-instrumentations/loader/module-hooks/registry";
import { installNodeModuleExportHooks } from "../auto-instrumentations/loader/module-hooks/node";
import { patchTracingChannel } from "../auto-instrumentations/patch-tracing-channel";
import { readDisabledInstrumentationEnvConfig } from "../instrumentation/config";

interface ApplyAutoInstrumentationState {
  applied?: boolean;
}

const stateKey = Symbol.for("braintrust.applyAutoInstrumentation");
const existingState = Object.getOwnPropertyDescriptor(
  globalThis,
  stateKey,
)?.value;
const state: ApplyAutoInstrumentationState = isApplyAutoInstrumentationState(
  existingState,
)
  ? existingState
  : {};

if (state !== existingState) {
  Object.defineProperty(globalThis, stateKey, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });
}

if (!state.applied) {
  patchTracingChannel(diagnostics_channel.tracingChannel);

  const disabled = readDisabledInstrumentationEnvConfig(
    process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
  ).integrations;
  const orchestrionConfigs = getDefaultOrchestrionConfigs({
    disabledIntegrationConfig: disabled,
  });
  const moduleExportPatchConfigs = getDefaultModuleExportPatchConfigs({
    disabledIntegrationConfig: disabled,
    target: "node",
  });

  installModuleExportPatchRunner(
    moduleExportPatchConfigs,
    nodeModuleExportPatchRuntime,
  );

  const currentModuleUrl = getCurrentModuleUrl();
  const autoInstrumentationHookUrl = new URL(
    "./auto-instrumentations/hook.mjs",
    currentModuleUrl,
  ).href;
  const asyncImportHookUrl = new URL(autoInstrumentationHookUrl);
  asyncImportHookUrl.searchParams.set("braintrust-iitm-loader", "true");
  installNodeModuleExportHooks({
    asyncImportHookUrl: asyncImportHookUrl.href,
    configs: moduleExportPatchConfigs,
    registryImportUrl: autoInstrumentationHookUrl,
  });

  register("./auto-instrumentations/loader/esm.mjs", {
    parentURL: currentModuleUrl,
    data: { instrumentations: orchestrionConfigs },
  });

  state.applied = true;

  try {
    const patch = new ModulePatch({ instrumentations: orchestrionConfigs });
    patch.patch();
  } catch {
    // ESM instrumentation is already active; keep user code running if CJS patching fails.
  }
}

function isApplyAutoInstrumentationState(
  value: unknown,
): value is ApplyAutoInstrumentationState {
  return typeof value === "object" && value !== null;
}

function getCurrentModuleUrl(): string {
  if (typeof __filename !== "undefined") {
    return pathToFileURL(__filename).href;
  }

  const stack = new Error().stack ?? "";
  const match =
    stack.match(/\((file:\/\/[^)]+)\)/) ?? stack.match(/\s(file:\/\/\S+)/);
  if (match) {
    return match[1].replace(/:\d+:\d+$/, "");
  }

  return pathToFileURL(process.argv[1] ?? process.cwd()).href;
}

export {};
