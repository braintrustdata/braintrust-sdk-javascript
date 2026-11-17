# @braintrust/otel

Connect an application's OpenTelemetry pipeline to Braintrust.
The application selects and configures its OpenTelemetry SDK, processors, and transport.
This package depends on the public `@opentelemetry/api` API and the matching Braintrust SDK, with no OpenTelemetry SDK peer dependencies.

## Export with standard OTLP

Use your installed OTLP/HTTP exporter with Braintrust's endpoint and headers:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { braintrustOtlpConfig } from "@braintrust/otel";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(
    braintrustOtlpConfig({ parent: "project_name:my-project" }),
  ),
});
sdk.start();
```

`braintrustOtlpConfig()` returns `{ url, headers }` synchronously.
It does not create an exporter, contact Braintrust, register a provider, or create a project.
The exporter determines the wire encoding and content type.
Use exporter and SDK versions that are compatible with each other.

Options:

- `apiKey`: defaults to `BRAINTRUST_API_KEY`, then the nearest `.env.braintrust` file in Node.js.
- `apiUrl`: defaults to `BRAINTRUST_API_URL`, then `https://api.braintrust.dev`.
- `parent`: a Braintrust project or experiment identifier, such as `project_name:my-project` or `project_id:<id>`; defaults to `BRAINTRUST_PARENT`.
- `headers`: additional transport headers.
  The resolved API key and parent take precedence over authorization and routing headers, including differently cased names.

Missing credentials or parent configuration throw during setup.
There is no implicit default project.

## Braintrust processors and exporters

Use the adapters when you need Braintrust routing, span origin metadata, AI filtering, or export customization.
For OTel 3:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BraintrustExporter,
  BraintrustSpanProcessor,
  braintrustOtlpConfig,
} from "@braintrust/otel";

const exporter = new BraintrustExporter({
  exporter: new OTLPTraceExporter(
    braintrustOtlpConfig({ parent: "project_name:my-project" }),
  ),
});
const processor = new BraintrustSpanProcessor({
  processor: new BatchSpanProcessor({ exporter }),
  filterAISpans: true,
});
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();
```

For OTel 1 and 2, import `BatchSpanProcessor` from `@opentelemetry/sdk-trace-base` and construct it with `new BatchSpanProcessor(exporter)`.
The Braintrust adapters use the same entry point and options for all three SDK lines.

`BraintrustSpanProcessor` accepts a required `processor` instance.
It adds Braintrust routing from the supplied parent context, propagator baggage, parent span attributes, or active native Braintrust span.
It adds span origin metadata and optionally filters completed spans before forwarding them.
It forwards processor lifecycle hooks, including OTel 3’s optional `onEnding` hook.
It does not create a batch processor or exporter.

`BraintrustExporter` accepts a required `exporter` instance.
It enriches completed batches, optionally filters them, applies registered Braintrust span customizers, and forwards the resulting batch.
It does not batch spans again or force a transport flush after every export.
A processor alone does not apply export customizers; put `BraintrustExporter` around the transport when those customizers are required.

Both adapters accept:

- `filterAISpans`: defaults to `false`.
  When enabled, only spans with names or attributes starting with `gen_ai.`, `braintrust.`, `llm.`, `ai.`, or `traceloop.` pass.
  Routing and origin attributes alone do not make a span an AI span.
  Root spans receive no automatic exemption.
- `customFilter`: with filtering enabled, return `true` to keep a span, `false` to drop it, or `null`/`undefined` to use the default filter.
- `environment`: optional `{ type, name }` span origin metadata, otherwise inferred from the runtime environment.

Configure filtering on one adapter to avoid evaluating your filter twice.
The SDK owns sampling, batching, queue limits, and export timeouts.
The transport owns serialization and retries.

For Next.js Edge, use `OTLPHttpJsonTraceExporter` from `@vercel/otel` as the downstream exporter.
It uses `fetch`, which the Edge runtime supports.
The standard OTel browser exporter can require `XMLHttpRequest`.

## Context interoperability

```ts
import { setupOtelCompat } from "@braintrust/otel";

// Register your OTel provider and context manager first.
setupOtelCompat();
```

Native Braintrust spans and OTel spans can then share trace IDs and parent relationships.
The bridge uses only public OTel context APIs, including for instrumentation store propagation.
It requires a registered OTel context manager for asynchronous propagation.
`resetOtelCompat()` restores Braintrust's default context manager.

For explicit propagation:

- `contextFromSpan(span)` creates an OTel parent context from a native Braintrust span, including trace identity, trace state, and Braintrust baggage routing.
- `addParentToBaggage(parent, context?)` returns a context containing Braintrust routing baggage.
- `addSpanParentToBaggage(span, context?)` copies the span's routing attribute into baggage.
- `parentFromHeaders(headers)` extracts native Braintrust propagation context from W3C headers.

Use the returned context with `context.with(...)` or as the explicit parent argument to `tracer.startSpan(...)`.
These helpers do not replace the active context by themselves.

## Flush and shutdown

Flush the application's provider or processor to drain the SDK's queue.
`BraintrustExporter.forceFlush()` only waits for batches already received and flushes its downstream exporter when that method is available.
It cannot flush a queue that belongs to an upstream processor.

Each `BraintrustSpanProcessor` registers its downstream flush with Braintrust and removes its registration during shutdown.
Multiple processors can be registered at the same time.
The application owns provider shutdown; adapter shutdown delegates to its downstream instance once.

For the plain OTLP configuration path, connect a provider explicitly if Braintrust scorers need to flush OTel spans before querying:

```ts
import { registerOtelFlush } from "braintrust/instrumentation";

const unregister = registerOtelFlush(() => provider.forceFlush());
// When the application shuts down:
unregister();
await provider.shutdown();
```

## Migration

Replace `new BraintrustSpanProcessor({ apiKey, parent })` with an application-owned processor and exporter, as shown above.
Move credentials, API URL, parent, and custom headers to `braintrustOtlpConfig()`.
Replace the internal `_spanProcessor` option with the required `processor` option.
Replace `new BraintrustExporter({ apiKey, parent })` with `new BraintrustExporter({ exporter: ... })`.
Keep customizers at the exporter boundary and flush the provider or processor instead of relying on the old nested batch processor.

No `/v3` entry point or runtime SDK version detection is required.
Compatibility tests cover OTel 1, 2, and 3; new SDK versions still require verification of their public span contracts.
