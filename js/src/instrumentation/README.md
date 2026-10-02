# Writing Braintrust Instrumentation Plugins

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
before importing the main SDK, which enables instrumentation during platform
initialization. Use a bootstrap module before any auto-instrumentation preload
that initializes the SDK. Static imports of the main SDK are hoisted; use a
dynamic import after configuration:

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
stops the callback chain, and drops that outgoing record. Diagnostics do not
include the exception message, stack, or span payload, and are throttled to
the first failure plus at most one report per minute with a suppressed count. Promise rejections are
consumed without awaiting the result. Handle recovery inside the callback if
export should continue, and do not mutate the record after returning.
Export retries reuse the transformed record or drop result without invoking
callbacks or logging the failure again. Unrelated records and future records
from the same span are evaluated independently; previously exported records
cannot be retracted. Dropping a span's first record, which carries
`span_attributes` and `created`, while later merge records succeed can leave a
partial row without a name or type. Configuration is shared across SDK bundles.

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

Span customizers are not yet supported with OpenTelemetry compat mode
(`BRAINTRUST_OTEL_COMPAT` or `setupOtelCompat()`). Registering a non-empty list
while compat mode is active logs an error and leaves the previous registration
unchanged. Calling `setupOtelCompat()` after registering customizers logs an error
and continues enabling compat mode without clearing the registered list. Each
explicit registration or setup attempt logs once, not once per span or export.
Clearing customizers is always allowed and silent.

## Testing

Test at the narrowest useful layers:

1. Plugin unit tests for extraction and span handling.
2. Invocation runtime tests for wrapping and context behavior.
3. Orchestrion transformation tests for generated wrappers.
4. Bundler and loader tests for real transformed execution.
5. Provider e2e tests for wrapped and auto-hook parity.

After instrumentation changes, run e2e tests in cassette replay mode. When an
e2e scenario itself changes, run it three times to catch flakes.
