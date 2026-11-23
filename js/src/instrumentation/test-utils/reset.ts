import {
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION,
} from "../../global-instrumentation-hooks";

/** Simulate a fresh process for tests of configuration before registration. */
export function resetInstrumentationForTest(): void {
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  delete root[
    Symbol.for(
      `braintrust.registry.global-hooks.v${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION}`,
    )
  ];
  (
    root[GLOBAL_INSTRUMENTATION_HOOKS_KEY] as Map<string, unknown> | undefined
  )?.clear();
}
