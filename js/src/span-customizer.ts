import type { SpanCustomizer, SpanExportData } from "./instrumentation/config";

// Configuration can precede platform initialization and must be shared across
// SDK bundles without importing the provider plugin registry into the logger.
const SPAN_CUSTOMIZERS_KEY = Symbol.for("braintrust.spanCustomizers");
const shared: typeof globalThis & {
  [SPAN_CUSTOMIZERS_KEY]?: readonly SpanCustomizer[];
} = globalThis;

export function setSpanCustomizers(
  customizers: readonly SpanCustomizer[] | undefined,
): void {
  shared[SPAN_CUSTOMIZERS_KEY] = customizers;
}

export function customizeSpanExport(data: SpanExportData): SpanExportData {
  const customizers = shared[SPAN_CUSTOMIZERS_KEY];
  if (!customizers) return data;

  for (const customizer of customizers) {
    try {
      if (customizer.onSpanExport) {
        data = customizer.onSpanExport(data);
      }
    } catch {
      // Customization must not prevent export or later customizers from running.
    }
  }
  return data;
}
