# Client-side trace sampling

Native Braintrust project-log traces can be sampled at their root:

```ts
const logger = initLogger({ projectName: "production", sampleRate: 0.2 });
```

`sampleRate` is a fraction from `0` through `1` and defaults to `1`. The SDK
uses a deterministic decision derived from the root trace ID, so all native
children make the same decision. A rejected trace still carries trace context
and stable IDs, but `span.isRecording()` is `false` and no rows are queued.

Use a root-only override for exceptional operations:

```ts
logger.startSpan({ name: "priority-request", sampleRate: 1 });
```

An existing local, exported, W3C, or OpenTelemetry parent always takes
precedence over either rate. The sampled bit is forwarded in `traceparent` and
native span exports, including unsampled (`00`) continuations. New local
Experiment roots remain recorded; an Experiment that continues an unsampled
parent remains non-recording to preserve distributed trace coherence.

When OpenTelemetry owns span creation, configure its provider sampler instead.
The `@braintrust/otel` integration preserves the provider's decision and does
not apply `Logger.sampleRate` a second time.

Sampling is probabilistic head sampling, not a maximum traces-per-second or
bytes-per-minute limiter. Older SDK processes that do not understand the
optional native export-token flags may record an unsampled continuation.
