import type {
  EveInstrumentationDefinition,
  EveProviderDefinition,
} from "../../vendor-sdk-types/eve";
import {
  createLegacyEveInstrumentation,
  type EveDefineState,
} from "./eve-plugin";
import { createEveInstrumentationProvider } from "./eve-provider";

const EVE_INSTRUMENTATION_PROVIDER = Symbol.for("eve.instrumentation.provider");

type LegacyEveInstrumentationOptions = {
  defineState: EveDefineState;
  setup?: EveInstrumentationDefinition["setup"];
};

type EveProviderInstrumentationOptions = {
  metadata?: Record<string, unknown>;
  setup?: EveProviderDefinition["setup"];
};

/**
 * Braintrust instrumentation for Eve.
 *
 * Pass `defineState` when using Eve's legacy authored instrumentation API.
 * With Eve 0.34+, omit `defineState` to use the instrumentation-provider
 * lifecycle and enable `experimental.instrumentationProviders` on the agent.
 * The result is ready to export directly from the instrumentation module.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Eve compatibility boundary. */
export function braintrustEveInstrumentation(
  options: EveProviderInstrumentationOptions,
): any;
// Keep the legacy overload last so utility types retain the existing signature.
export function braintrustEveInstrumentation(options: {
  defineState: EveDefineState;
  setup?: EveInstrumentationDefinition["setup"];
}): any;
export function braintrustEveInstrumentation(
  options: LegacyEveInstrumentationOptions | EveProviderInstrumentationOptions,
): any {
  if (!options || typeof options !== "object") {
    throw new TypeError(
      "braintrustEveInstrumentation requires an options object",
    );
  }
  const definition =
    "defineState" in options
      ? createLegacyEveInstrumentation(options)
      : createEveInstrumentationProvider(options);
  const declaration = {
    ...definition,
    [EVE_INSTRUMENTATION_PROVIDER]: true,
  };
  return declaration;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
