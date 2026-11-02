# Braintrust Instrumentation Consumers

API wrapping and span instrumentation are separate layers.
Invocation hooks work independently of the SDK; provider plugins explicitly connect them to tracing functions.

## Define wrapping hooks

```ts
const providerHooks = defineInterceptor("provider-package", {
  create: channel<[CreateParams], PromiseLike<CreateResult>>({
    channelName: "messages.create",
  }),
});
```

The identifier must match the Orchestrion config: `orchestrion:<package>:<operation>`.
Definitions describe arguments, return values, and opaque additional data.
They do not contain span names, instrumentation provenance, or tracing methods.

Interceptors compose in registration order and may replace arguments, receivers, results, or the entire call.
Removing an interceptor is idempotent.
Wrapping can scope a call without creating spans:

```ts
const remove = providerHooks.create.intercept((target, receiver, args) =>
  store.run(context, () => Reflect.apply(target, receiver, args)),
);
```

## Trace independently

Tracing helpers receive a callable and tracing data; they never receive a hook or register interceptors.
Provider plugins explicitly connect the layers:

```ts
this.unsubscribers.push(
  providerHooks.create.intercept((target, receiver, args, additional) =>
    traceAsyncCall<typeof providerHooks.create>(
      () => Reflect.apply(target, receiver, args),
      { ...additional, arguments: args, self: receiver },
      {
        name: "provider.messages.create",
        instrumentationName: INSTRUMENTATION_NAMES.PROVIDER,
        type: "llm",
        extractInput: ([params]) => ({
          input: params.messages,
          metadata: { model: params.model },
        }),
        extractOutput: (result) => result.content,
        extractMetrics: (result) => ({ tokens: result.usage.totalTokens }),
      },
    ),
  ),
);
```

The tracing function owns span creation, context propagation, response observation, and finalization.
It preserves the original return value, including Promise subclasses and stream identity.
Do not introduce combined registration APIs such as `interceptAndTrace` or `traceInvocation`.

## Manual wrappers

Manual and generated wrappers invoke the same hook:

```ts
return providerHooks.create.invoke(originalCreate, client, [params], {});
```

Without an interceptor the original function runs directly.
With a tracing plugin enabled the registered tracing function creates spans.
Manual wrappers must not create spans themselves.

## Runtime and safety requirements

- Preserve receivers, arguments, errors, async context, Promise helper methods, and stream cancellation.
- Treat provider inputs and outputs as untrusted and capture only specification-permitted data.
- Keep registration, removal, and stream patching idempotent.
- Contain extraction failures with `debugLogger` without retrying the provider call.
- Pass `Error` objects directly to `span.log({ error })`.
- Treat `span.log()` and `span.end()` as non-throwing.

Invocation protocol version 2 uses an independent global registry.
Rebuild bundles transformed with the previous SDK when upgrading; the old combined tracing protocol is not supported.

## Export Customizers

Configure `spanCustomizers` through the standalone instrumentation entrypoint
before importing `braintrust` or `@braintrust/otel`. The main SDK enables
instrumentation during platform initialization. Use a bootstrap module before
any auto-instrumentation preload that initializes the SDK. Static imports are
hoisted; use a dynamic import after configuration:

```ts
import { configureInstrumentation } from "braintrust/instrumentation";

configureInstrumentation({
  spanCustomizers: [
    {
      onSpanExport(data) {
        data.tags = ["reviewed"];
        if ("output" in data) data.output = "[redacted]";
        delete data.error;
        return data;
      },
    },
  ],
});

const { initLogger } = await import("braintrust");
initLogger({ projectName: "my-project" });
// Create manual spans or import and use instrumented provider SDKs here.
```

`onSpanExport` receives each incremental record from every native SDK span,
including manually created root and child spans, instrumented spans, and spans
created by logger and experiment logging. It runs after lazy values resolve,
before attachment processing, merging, masking, and JSON serialization. It can
run before the span ends and multiple times for one span; fields may be absent.
Dataset rows and feedback records are not customized.

Callbacks run synchronously in registration order. Mutate and return the record,
or return a replacement plain object for the next callback. If a callback throws
or returns an invalid value (including a promise), the SDK logs a safe error,
stops the callback chain, and exports only original identity, routing, and
duration timestamps plus `context: { customizer_error: true }`. No attachments
from that record upload. Diagnostics do not include the exception message,
stack, or span payload, and are logged at most once per JavaScript global
environment. Promise rejections are consumed without awaiting the result.
Handle recovery inside the callback to retain span content, and do not mutate
the record after returning. Export retries reuse the transformed or stripped
record without invoking callbacks or logging the failure again. Stripped
records bypass downstream masking and remain separate from other updates
with the same ID in ordered export requests. Unrelated records and future
records from the same span are evaluated independently; previously exported
records cannot be retracted. Configuration is shared across SDK bundles.

The SDK restores these fields after every callback, including removing injected
fields that were absent from the original record:

- Identity: `id`, `span_id`, `root_span_id`, `span_parents`.
- Routing: `org_id`, `project_id`, `experiment_id`, `dataset_id`,
  `prompt_session_id`, `log_id`, `function_data`.
- Transport controls: `_is_merge`, `_merge_paths`, `_parent_id`, `_object_delete`,
  `_array_delete`, `_xact_id`.

Payload values must remain supported by the SDK logging pipeline. They can still
include SDK `Attachment` objects at this point, including ones instrumentation
created from inline media at capture time; attachment processing and JSON
serialization happen after customization. Remove or replace an attachment to
prevent its upload.

This is an export-only hook, not a local-cache privacy boundary. Callbacks
receive copies of plain objects and arrays, so mutations never reach the local
experiment/scorer cache, which is populated before export with the original,
uncustomized values. Applications requiring secrets to stay off local disk must
disable the span cache separately; export customization alone does not provide
that guarantee.

Customizers receive only the outgoing record, not a live span or provider
instrumentation context.

### OpenTelemetry spans

The same registration applies to spans exported through `@braintrust/otel`'s
`BraintrustSpanProcessor` or `BraintrustExporter`, including compatibility mode
(`BRAINTRUST_OTEL_COMPAT` or `setupOtelCompat()`). Compatibility mode is not
required to customize OTel exports. Native spans still use the native record
shape above; OTel hooks receive an isolated plain snapshot, not a live
`ReadableSpan` or a converted native record:

- `name`, `kind`, `attributes`, `status: { code, message? }`, `events`, `links`.
- `spanContext: { traceId, spanId, traceFlags, traceState?, isRemote? }`,
  `parentSpanId`, `parentSpanContext`, `startTime`, `endTime`, `duration`.
  `spanContext` is an object, not a method. Times are OTel
  `[seconds, nanoseconds]` arrays; trace state is a string.
- `resource: { attributes, schemaUrl? }`, `instrumentationScope:
  { name, version?, schemaUrl?, attributes? }`, and dropped attribute/event/link
  counts. OTel 1.x's instrumentation library is exposed as `instrumentationScope`.
- Events contain `name`, `time`, optional attributes and dropped count; links
  contain a plain `context` (the same shape as `spanContext`), optional attributes
  and dropped count.

Hooks run after AI filtering and SDK origin enrichment, before OTLP
serialization. Pending resource attributes are awaited before taking the
snapshot. Plain nested containers are copied, so hook mutations do not affect
the original span or another exporter. Replacement objects are not merged with
the original: omitted content is removed, with empty OTLP defaults where
required. Original identity, parent relationships, timestamps and
`braintrust.parent` routing are restored after each callback.

For example, register one synchronous hook that handles both payload shapes:

```ts
import { configureInstrumentation } from "braintrust/instrumentation";

configureInstrumentation({
  spanCustomizers: [
    {
      onSpanExport(data) {
        if ("attributes" in data) {
          const attributes = data.attributes as Record<string, unknown>;
          delete attributes["braintrust.input_json"];
          delete attributes["braintrust.output_json"];
          delete attributes["gen_ai.prompt"];
          delete attributes["gen_ai.completion"];
          data.events = [];
        } else {
          delete data.input;
          delete data.output;
        }
        return data;
      },
    },
  ],
});

// Import the application and its tracing setup only after registration.
await import("./app.js");
```

This example removes common prompt/output attributes and events, not every
possible sensitive field. Adjust redaction to the instrumentation you use,
including resource/scope metadata, links and status descriptions as needed.

Thrown exceptions, promises, non-plain returns and invalid OTel serialization
shapes stop the callback chain and fail closed. The failed span keeps only
original identity, timestamps, routing and `braintrust.context_json` exactly
`{"customizer_error":true}`. Names, status descriptions, events, links,
resource/scope metadata and original context/origin are removed. Malformed spans
that cannot be safely adapted are dropped instead. The safe once-only diagnostic
is shared with the native pipeline across ESM/CJS bundles. Composing the
Braintrust processor and exporter does not invoke hooks twice; retries of the
prepared transport data do not rerun hooks. Submitting the original span again
is a new export.

## Testing

Test at the narrowest useful layers:

1. Plugin unit tests for extraction and span handling.
2. Invocation runtime tests for wrapping and context behavior.
3. Orchestrion transformation tests for generated wrappers.
4. Bundler and loader tests for real transformed execution.
5. Provider e2e tests for wrapped and auto-hook parity.

After instrumentation changes, run e2e tests in cassette replay mode. When an
e2e scenario itself changes, run it three times to catch flakes.
