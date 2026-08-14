---
"braintrust": minor
"@braintrust/otel": patch
---

Add deterministic client-side head sampling for native JavaScript traces with
Logger and root-span `sampleRate` controls. Rejected traces preserve context
without emitting rows, and native/OpenTelemetry propagation now retains raw
trace flags. `Span` adds `isRecording()`; TypeScript consumers that structurally
implement `Span` should add that method.
