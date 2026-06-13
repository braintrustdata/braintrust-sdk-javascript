# @braintrust/otel

[![npm version](https://img.shields.io/npm/v/%40braintrust%2Fotel.svg)](https://www.npmjs.com/package/@braintrust/otel)

SDK for integrating [Braintrust](https://braintrust.dev) with [OpenTelemetry](https://opentelemetry.io/). This package enables you to send OpenTelemetry spans to Braintrust for logging and observability, and provides seamless interoperability between Braintrust and OpenTelemetry tracing contexts.

## Installation

This package has peer dependencies that you must install alongside it:

```bash
npm install @braintrust/otel braintrust @opentelemetry/api @opentelemetry/core @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http
# or
yarn add @braintrust/otel braintrust @opentelemetry/api @opentelemetry/core @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http
# or
pnpm add @braintrust/otel braintrust @opentelemetry/api @opentelemetry/core @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http
```

If you're using additional OpenTelemetry features like context managers, you may also need:

```bash
npm install @opentelemetry/context-async-hooks
```

## Requirements

- Node.js >= 16
- OpenTelemetry API >= 1.9.0
- OpenTelemetry SDK >= 1.9.0
- Braintrust >= 0.5.0

This package supports both OpenTelemetry 1.x and 2.x versions.

Note: You may run into a known [OpenTelemetry browser bug](https://github.com/open-telemetry/opentelemetry-js/issues/3545) with `@opentelemetry/exporter-trace-otlp-http` < 0.205.0. If you encounter this issue, upgrade the `@opentelemetry/exporter-trace-otlp-http` and related packages to a minimum of:

- `@opentelemetry/exporter-trace-otlp-http` >= 0.205.0
- `@opentelemetry/sdk-trace-base` >= 2.1.0
- `@opentelemetry/api` >= 2.1.0
- `@opentelemetry/core` >= 2.1.0

It's **important** that `@opentelemetry/core` and related packages all use the same major version (1.x or 2.x).

## Capabilities

This integration provides two main capabilities:

1. **Export OpenTelemetry spans to Braintrust**: Use `BraintrustSpanProcessor` to send your OpenTelemetry traces to Braintrust for logging, monitoring, and analysis.

2. **Bidirectional interoperability between Braintrust and OpenTelemetry**: Use `setupOtelCompat()` to enable Braintrust spans and OpenTelemetry spans to work together in the same unified trace. This allows:
   - OpenTelemetry spans to be children of Braintrust spans
   - Braintrust spans to be children of OpenTelemetry spans
   - Both systems share the same trace/span IDs (using OpenTelemetry's format)
   - Seamless context propagation across service boundaries, regardless of which tracing system each service uses

## Core Components

### `BraintrustSpanProcessor`

A span processor that sends OpenTelemetry spans to Braintrust's telemetry endpoint.

**When to use it**: Add this processor to your OpenTelemetry `TracerProvider` when you want to export OpenTelemetry spans to Braintrust. This is useful when you're already using OpenTelemetry instrumentation and want to leverage Braintrust's logging and observability features.

**Key features**:

- Automatically sends spans to Braintrust using OTLP protocol
- Optional AI span filtering to reduce noise from non-AI operations
- Supports custom filtering logic
- Configurable via options or environment variables

```typescript
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { BraintrustSpanProcessor } from "@braintrust/otel";

const provider = new BasicTracerProvider();
provider.addSpanProcessor(
  new BraintrustSpanProcessor({
    apiKey: "your-api-key", // or set BRAINTRUST_API_KEY env var
    parent: "project_name:my_project", // or set BRAINTRUST_PARENT env var
    filterAISpans: true, // optional: filter out non-AI spans
  }),
);

trace.setGlobalTracerProvider(provider);
```

**Configuration options**:

- `apiKey` (string, optional): Braintrust API key. Falls back to the `BRAINTRUST_API_KEY` environment variable, then the nearest `.env.braintrust` file in Node.js.
- `apiUrl` (string, optional): Braintrust API URL. Falls back to `BRAINTRUST_API_URL` environment variable. Defaults to `https://api.braintrust.dev`.
- `parent` (string, optional): Parent project identifier in format `project_name:my_project` or `project_id:uuid`. Falls back to `BRAINTRUST_PARENT` environment variable.
- `filterAISpans` (boolean, optional): When true, filters out non-AI spans. Only spans with prefixes like `gen_ai.*`, `llm.*`, `ai.*`, `braintrust.*`, or `traceloop.*` will be sent. Defaults to false.
- `customFilter` (function, optional): Custom filter function for advanced span filtering logic.
- `headers` (object, optional): Additional HTTP headers to send with telemetry data.

### `setupOtelCompat()`

Configures Braintrust to use OpenTelemetry's context management and ID generation, enabling bidirectional interoperability.

**When to use it**: Call this function **once at application startup, before creating any Braintrust loggers or OpenTelemetry spans**. This configures Braintrust to integrate with OpenTelemetry tracing contexts and enables:

- **Braintrust spans to appear as children of OpenTelemetry spans**: When you create a Braintrust span inside an OpenTelemetry span context, it automatically becomes a child
- **OpenTelemetry spans to appear as children of Braintrust spans**: When you create an OpenTelemetry span inside a Braintrust span context, it automatically becomes a child
- **Unified trace structure**: Both systems use OpenTelemetry-compatible trace and span IDs, so spans from both systems appear in the same trace tree
- **Distributed tracing**: Proper context propagation across services that use different tracing systems

```typescript
import { setupOtelCompat } from "@braintrust/otel";
import { initLogger } from "braintrust";

// IMPORTANT: Call setupOtelCompat() before creating any Braintrust loggers or OpenTelemetry spans
setupOtelCompat();

// Now Braintrust will use OpenTelemetry context management
const logger = initLogger({ projectName: "my_project" });
```

**What it does**:

- Sets Braintrust to use OpenTelemetry's context manager for parent-child span relationships
- Configures Braintrust to use OpenTelemetry-compatible span and trace IDs
- Enables seamless mixing of Braintrust and OpenTelemetry spans in the same trace

## Distributed Tracing Helpers

These utilities enable distributed tracing across services that use different tracing systems (Braintrust and OpenTelemetry).

### `contextFromSpanExport(exportStr: string)`

Creates an OpenTelemetry context from a Braintrust span export string.

**When to use it**: When Service A uses Braintrust and sends a span export to Service B that uses OpenTelemetry. This allows Service B to create spans as children of Service A's span.

```typescript
import { contextFromSpanExport } from "@braintrust/otel";
import { context } from "@opentelemetry/api";

// Service A (Braintrust) exports span
const exportedSpan = await spanA.export();

// Service B (OpenTelemetry) imports context
const ctx = contextFromSpanExport(exportedSpan);
await context.with(ctx, async () => {
  // OpenTelemetry spans created here will be children of Service A's span
  await tracer.startActiveSpan("service_b_operation", async (span) => {
    // ...
    span.end();
  });
});
```

### `addSpanParentToBaggage(span: Span, ctx?: Context)`

Copies the `braintrust.parent` attribute from an OpenTelemetry span to OpenTelemetry baggage.

**When to use it**: When you need to propagate Braintrust parent information across service boundaries using OpenTelemetry's propagation mechanism (typically before calling `propagation.inject()`).

```typescript
import { addSpanParentToBaggage } from "@braintrust/otel";
import { propagation, context } from "@opentelemetry/api";

tracer.startActiveSpan("service_a", async (span) => {
  // Copy braintrust.parent to baggage so it propagates
  const ctx = addSpanParentToBaggage(span);

  // Export headers for downstream service
  const headers = {};
  propagation.inject(ctx, headers);

  // Send headers to Service B
  await fetch("https://service-b/api", { headers });

  span.end();
});
```

### `addParentToBaggage(parent: string, ctx?: Context)`

Adds a Braintrust parent identifier directly to OpenTelemetry baggage.

**When to use it**: When you have a Braintrust parent string and want to add it to OpenTelemetry context for propagation.

```typescript
import { addParentToBaggage } from "@braintrust/otel";

const parent = "project_name:my_project";
const ctx = addParentToBaggage(parent);
// Now ctx contains braintrust.parent in baggage
```

### `parentFromHeaders(headers: Record<string, string>)`

Extracts Braintrust parent information from HTTP headers that contain OpenTelemetry trace context.

**When to use it**: When Service A uses OpenTelemetry and sends trace headers to Service B that uses Braintrust. This allows Service B to create Braintrust spans as children of Service A's span.

```typescript
import { parentFromHeaders } from "@braintrust/otel";
import { initLogger } from "braintrust";

// Service B receives headers from Service A (OpenTelemetry)
const parent = parentFromHeaders(incomingHeaders);

// Create Braintrust span as child of Service A's span
const logger = initLogger({ projectName: "my_project" });
await logger.traced(
  async (span) => {
    // This span will be a child of Service A's span
    span.log({ message: "Processing in Service B" });
  },
  { name: "service_b_operation", parent },
);
```

## Environment Variables

The following environment variables can be used to configure the integration:

- `BRAINTRUST_API_KEY`: Your Braintrust API key (required for `BraintrustSpanProcessor`; in Node.js, this can also be set in the nearest `.env.braintrust` file)
- `BRAINTRUST_PARENT`: Parent project identifier (e.g., `project_name:my_project`)
- `BRAINTRUST_API_URL`: Braintrust API endpoint (defaults to `https://api.braintrust.dev`)

## Documentation

- [Braintrust Documentation](https://www.braintrust.dev/docs)
- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Braintrust OTEL Guide](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry)
