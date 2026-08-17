import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { getDefaultAutoInstrumentationConfigs } from "../auto-instrumentations/configs/all";
import { ModulePatch } from "../auto-instrumentations/loader/cjs-patch";
import { debugLogger } from "../debug-logger";
import { GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION } from "../global-instrumentation-hooks";

interface ApplyAutoInstrumentationState {
  applied?: boolean;
}

const stateKey = Symbol.for(
  `braintrust.applyAutoInstrumentation.global-hooks.v${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION}`,
);

export function applyAutoInstrumentation(): void {
  const existingState = Object.getOwnPropertyDescriptor(
    globalThis,
    stateKey,
  )?.value;
  const state: ApplyAutoInstrumentationState =
    typeof existingState === "object" && existingState !== null
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

  if (state.applied) {
    return;
  }

  const allConfigs = getDefaultAutoInstrumentationConfigs();
  const currentModuleUrl = getCurrentModuleUrl();

  register("./auto-instrumentations/loader/esm-hook.mjs", {
    parentURL: currentModuleUrl,
    data: { instrumentations: allConfigs },
  });
  state.applied = true;

  try {
    new ModulePatch({ instrumentations: allConfigs }).patch();
  } catch (error) {
    debugLogger.warn(
      "Failed to enable CommonJS auto-instrumentation; ESM instrumentation remains active:",
      error,
    );
  }
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
