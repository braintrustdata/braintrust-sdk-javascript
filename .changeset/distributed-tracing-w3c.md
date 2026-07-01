---
"braintrust": minor
---

feat: W3C-compatible distributed tracing

- Add `inject`/`extract` APIs for distributed tracing across service boundaries
  (`span.inject(carrier)`, `injectTraceContext()`, and `extractTraceContext(headers)`),
  implementing the [W3C Trace Context](https://www.w3.org/TR/trace-context/) and
  [W3C Baggage](https://www.w3.org/TR/baggage/) specs. `startSpan({ parent })` now
  accepts the opaque context returned by `extractTraceContext` in addition to an
  exported span slug.
- Default to OpenTelemetry-compatible hex span/trace IDs (and V4 span-component
  export). Set `BRAINTRUST_LEGACY_IDS` to opt back into legacy UUID IDs (and V3
  export). `BRAINTRUST_OTEL_COMPAT` continues to force hex IDs and takes
  precedence over `BRAINTRUST_LEGACY_IDS`.

Note: The deprecated `span.export()` / `startSpan({ parent: <slug> })` path remains
supported and links correctly across the UUID and hex formats.
