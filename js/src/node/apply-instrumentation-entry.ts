import * as diagnostics_channel from "node:diagnostics_channel";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { getDefaultAutoInstrumentationConfigs } from "../auto-instrumentations/configs/all";
import { ModulePatch } from "../auto-instrumentations/loader/cjs-patch";
import { patchTracingChannel } from "../auto-instrumentations/patch-tracing-channel";

interface ApplyInstrumentationState {
  applied?: boolean;
}

const stateKey = Symbol.for("braintrust.applyInstrumentation");
const existingState = Object.getOwnPropertyDescriptor(
  globalThis,
  stateKey,
)?.value;
const state: ApplyInstrumentationState = isApplyInstrumentationState(
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

  const currentModuleUrl = getCurrentModuleUrl();
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

function isApplyInstrumentationState(
  value: unknown,
): value is ApplyInstrumentationState {
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
