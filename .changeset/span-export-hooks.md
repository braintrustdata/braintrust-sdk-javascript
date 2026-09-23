---
"braintrust": minor
---

feat: add span export hooks

Support synchronous `onSpanExport` customizers for incremental instrumentation
span records. Customizers can add, modify, delete, or replace fields before export,
with callbacks applied once per record rather than once per transport retry.
