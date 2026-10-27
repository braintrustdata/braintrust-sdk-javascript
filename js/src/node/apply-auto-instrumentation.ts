import * as nodeModule from "node:module";
import { getDefaultAutoInstrumentationConfigs } from "../auto-instrumentations/configs/all";
import { patchCommonJS } from "../auto-instrumentations/loader/cjs-patch";
import {
  initialize,
  loadSync,
  syncTransformedSources,
} from "../auto-instrumentations/loader/module-hooks.mjs";
import { debugLogger } from "../debug-logger";
import { getCurrentModuleUrl } from "./module-url";
import { GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION } from "../global-instrumentation-hooks";

interface ApplyAutoInstrumentationState {
  applied?: boolean;
}

const stateKey = Symbol.for(
  `braintrust.applyAutoInstrumentation.global-hooks.v${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION}`,
);

export function applyAutoInstrumentation(loaderUrl?: URL): void {
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

  if (
    "registerHooks" in nodeModule &&
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    typeof nodeModule.registerHooks === "function" &&
    supportsSyncHooks()
  ) {
    initialize({ instrumentations: allConfigs });
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    nodeModule.registerHooks({ load: loadSync });
  } else {
    nodeModule.register(
      loaderUrl ??
        new URL(
          "./auto-instrumentations/loader/module-hooks.mjs",
          getCurrentModuleUrl(),
        ),
      { data: { instrumentations: allConfigs } },
    );
  }
  try {
    // Sync hooks cover CommonJS loaded by Node itself, but loaders such as tsx
    // replace Module._extensions and compile CommonJS without calling them.
    // The patch skips sources loadSync already transformed.
    patchCommonJS(allConfigs, syncTransformedSources);
  } catch (error) {
    debugLogger.warn(
      "Failed to enable CommonJS auto-instrumentation; ESM instrumentation remains active:",
      error,
    );
  }
  state.applied = true;
  debugLogger.debug(
    "Auto-instrumentation active for:",
    allConfigs.map((c) => c.channelName).join(", "),
  );
}

/**
 * When another tool's module.register() loader is active, sync load hooks
 * receive nullish CommonJS source. Node rejected passing that through with
 * `ERR_INVALID_RETURN_PROPERTY_VALUE` until
 * https://github.com/nodejs/node/pull/59929, released in 22.22.3, 24.11.1,
 * 25.1.0 and 26.0.0. Older versions with `registerHooks` use register().
 */
export function supportsSyncHooks(): boolean {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major >= 26) return true;
  if (major === 25) return minor >= 1;
  if (major === 24) return minor > 11 || (minor === 11 && patch >= 1);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 3);
  return false;
}
