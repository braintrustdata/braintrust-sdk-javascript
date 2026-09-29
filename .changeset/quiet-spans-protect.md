---
"braintrust": minor
---

feat: Apply span export customizers to all native SDK span records and fail closed

This changes `onSpanExport` behavior shipped in 3.35. Customizers previously ran only on instrumentation-created spans and failed open; they now run on every native SDK span record and drop the record when a callback fails.

- Customizers run for manual, instrumented, logger, and experiment spans, including incremental `updateSpan` records, before attachment processing, merging, masking, and serialization. Dataset rows and feedback remain excluded.
- Exceptions, asynchronous callbacks, and invalid return values stop the callback chain and drop the current record without uploading its attachments. Failure diagnostics omit record and exception details and are throttled.
- Span customizers are not yet supported with OpenTelemetry compat mode. Registering a non-empty list while `BRAINTRUST_OTEL_COMPAT` or `setupOtelCompat()` is active logs one error per attempt and leaves the previous registration unchanged; clearing customizers is always allowed and silent.
- Callbacks receive copies of plain objects and arrays, so in-place mutations no longer affect the local span cache. Span identity and routing fields are preserved, and customization results are memoized for retries.

Existing customizers must now tolerate records from spans they did not previously see and records where fields are absent (guard before reading `input`, `output`, `metadata`, etc.), and must catch their own errors if a failure should not drop the record.
