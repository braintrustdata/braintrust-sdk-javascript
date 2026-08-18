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
export function braintrustEveInstrumentation(
  options: LegacyEveInstrumentationOptions,
): EveInstrumentationDefinition;
export function braintrustEveInstrumentation(
  options: EveProviderInstrumentationOptions,
): EveProviderDefinition;
export function braintrustEveInstrumentation(
  options: LegacyEveInstrumentationOptions | EveProviderInstrumentationOptions,
): EveInstrumentationDefinition | EveProviderDefinition {
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
