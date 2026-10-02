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
 * lifecycle. Eve before 0.62 also requires
 * `experimental.instrumentationProviders` on the agent.
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
  if ("defineState" in options) {
    return {
      ...createLegacyEveInstrumentation(options),
      [EVE_INSTRUMENTATION_PROVIDER]: true,
    };
  }
  // Eve before 0.47.4 only reads `capture` to decide whether provider events
  // include content, while eve 0.62+ rejects providers that own a `capture`
  // key. Inheriting it keeps content for old versions without tripping that
  // own-property check.
  return Object.assign(
    Object.create({ capture: "content" }),
    createEveInstrumentationProvider(options),
    { [EVE_INSTRUMENTATION_PROVIDER]: true },
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
