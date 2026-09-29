import { OtelContextManager } from "./context";
import { _internalGetGlobalState } from "braintrust";

export {
  contextFromSpanExport,
  addSpanParentToBaggage,
  addParentToBaggage,
  parentFromHeaders,
  isRootSpan,
} from "./otel";

import { OTELIDGenerator } from "./otel";
import { SpanComponentsV4 } from "braintrust/util";

export { BraintrustSpanProcessor, BraintrustExporter } from "./otel";

function resetBraintrustCompatCaches() {
  const state = _internalGetGlobalState();
  if (!state) {
    return;
  }

  // Node/browser package initialization can cache native context and ID state
  // before setupOtelCompat() runs. Reset both so subsequent lookups honor the
  // compat-mode globals we are about to install.
  (state as unknown as { _contextManager: unknown })._contextManager = null;
  (state as unknown as { _idGenerator: unknown })._idGenerator = null;
}

export const setupOtelCompat = () => {
  // Read braintrust's shared registration directly so this works with any
  // supported braintrust version. Keep the message in sync with braintrust.
  const spanCustomizers: unknown = (globalThis as Record<symbol, unknown>)[
    Symbol.for("braintrust.spanCustomizers")
  ];
  if (Array.isArray(spanCustomizers) && spanCustomizers.length) {
    // eslint-disable-next-line no-restricted-properties -- intentional always-visible configuration error.
    console.error(
      "Braintrust span customizers are not supported with OpenTelemetry compat mode yet.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  (globalThis as any).BRAINTRUST_CONTEXT_MANAGER = OtelContextManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  (globalThis as any).BRAINTRUST_ID_GENERATOR = OTELIDGenerator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  (globalThis as any).BRAINTRUST_SPAN_COMPONENT = SpanComponentsV4;
  resetBraintrustCompatCaches();
};

export const resetOtelCompat = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  (globalThis as any).BRAINTRUST_CONTEXT_MANAGER = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  (globalThis as any).BRAINTRUST_ID_GENERATOR = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  (globalThis as any).BRAINTRUST_SPAN_COMPONENT = undefined;
  resetBraintrustCompatCaches();
};
