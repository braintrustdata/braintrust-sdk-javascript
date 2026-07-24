import * as diagnostics_channel from "node:diagnostics_channel";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { getDefaultAutoInstrumentationConfigs } from "../auto-instrumentations/configs/all";
import { ModulePatch } from "../auto-instrumentations/loader/cjs-patch";
import { installMastraExporterFactory } from "../auto-instrumentations/loader/mastra-observability-patch";
import {
  getDefaultTopLevelImportHooks,
  installTopLevelImportHookRunner,
} from "../auto-instrumentations/loader/top-level-export-patches";
import { installNodeTopLevelExportPatches } from "../auto-instrumentations/loader/top-level-export-patches-node";
import { patchTracingChannel } from "../auto-instrumentations/patch-tracing-channel";
import {
  isInstrumentationIntegrationDisabled,
  readDisabledInstrumentationEnvConfig,
} from "../instrumentation/config";
import { BraintrustObservabilityExporter } from "../wrappers/mastra";

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

  const allConfigs = getDefaultAutoInstrumentationConfigs();
  const disabled = readDisabledInstrumentationEnvConfig(
    process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
  ).integrations;
  if (!isInstrumentationIntegrationDisabled(disabled, "mastra")) {
    installMastraExporterFactory(() => new BraintrustObservabilityExporter());
  }

  const currentModuleUrl = getCurrentModuleUrl();
  const topLevelImportHooks = getDefaultTopLevelImportHooks({
    disabledIntegrationConfig: disabled,
    target: "node",
  });
  const autoInstrumentationHookUrl =
    getAutoInstrumentationHookUrl(currentModuleUrl);
  installTopLevelImportHookRunner(topLevelImportHooks);
  installNodeTopLevelExportPatches({
    asyncImportHookUrl: getImportInTheMiddleLoaderUrl(
      autoInstrumentationHookUrl,
    ),
    hooks: topLevelImportHooks,
    registryImportUrl: autoInstrumentationHookUrl,
  });

  register("./auto-instrumentations/loader/esm-hook.mjs", {
    parentURL: currentModuleUrl,
    data: { instrumentations: allConfigs },
  });

  state.applied = true;

  try {
    const patch = new ModulePatch({ instrumentations: allConfigs });
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

function getAutoInstrumentationHookUrl(currentModuleUrl: string): string {
  return new URL("./auto-instrumentations/hook.mjs", currentModuleUrl).href;
}

function getImportInTheMiddleLoaderUrl(canonicalUrl: string): string {
  const parsed = new URL(canonicalUrl);
  parsed.searchParams.set("braintrust-iitm-loader", "true");
  return parsed.href;
}

export {};
