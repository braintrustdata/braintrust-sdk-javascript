# Braintrust Instrumentation Consumers

Braintrust instrumentation consumers wrap provider calls through typed
invocation hooks or consume tracing-compatible events from the internal global
registry.
Auto-instrumented provider code and manual wrappers use the same typed channels,
so extraction, stream handling, and span behavior stay aligned.

## Architecture

An instrumentation has four parts:

1. An Orchestrion config identifies the provider function for automatic
   transformation.
2. A typed channel defines its arguments, result, extra event fields, and stable
   `orchestrion:<package>:<operation>` identifier.
3. An internal consumer intercepts that channel, or subscribes to its legacy
   tracing lifecycle, and maps the call into Braintrust spans.
4. A manual wrapper invokes the same typed channel when transformation is not
   available.

The global hook transport and its consumers are internal. New and migrated
consumers should prefer the typed channel's `intercept` API. Existing consumers
can continue using `traceAsyncChannel`, `traceStreamingChannel`, or
`traceSyncStreamChannel` during the gradual migration.

## Invocation Hooks

Invocation hooks expose the complete target call and are designed for wrappers
that need to scope the target with `AsyncLocalStorage.run()` or patch arguments,
the receiver, or the returned value:

```ts
const removeInterceptor = providerChannels.create.intercept(
  (target, thisArg, args, additional) =>
    store.run(additional.context, () => target.apply(thisArg, args)),
);
```

Interceptors compose as nested middleware in registration order. Each receives
the next target and may invoke it with different arguments or receiver, replace
its result, call it more than once, or not call it at all. Removing an
interceptor is idempotent. Calling a typed channel through `invoke` only uses
the invocation hook and does not dispatch the legacy tracing lifecycle.
Generated auto-instrumentation wrappers separately retain dual emission during
the migration, with legacy tracing outside the effective intercepted call.

## Lifecycle

The event lifecycle is compatible with Node tracing channels:

- `start`: before the synchronous portion of the target function
- `end`: after the synchronous portion completes
- `asyncStart`: when an asynchronous result begins settling
- `asyncEnd`: after that result settles and before user continuation
- `error`: when the target throws, rejects, or reports a callback error

Every phase receives the same mutable context object:

```ts
interface InstrumentationContext {
  arguments: ArrayLike<unknown>;
  self?: unknown;
  moduleVersion?: string;
  result?: unknown;
  error?: unknown;
}
```

The generated wrapper passes the target invocation and `moduleVersion` to the
global hook runtime. That runtime creates `arguments` and `self`; tracing
operators add `result` or `error`.

## Defining Typed Channels

Define the smallest types needed by instrumentation:

```ts
const providerChannels = defineChannels(
  "provider-package",
  {
    create: channel<
      [CreateParams],
      CreateResult,
      { providerRequestId?: string }
    >({
      channelName: "messages.create",
      kind: "async",
    }),
  },
  { instrumentationName: "provider" },
);
```

Channel names must match the Orchestrion config exactly. Do not include the
`orchestrion:` prefix in the transform config; `defineChannels` and Orchestrion
construct it from the package and operation.

## Subscribing

Prefer the shared tracing helpers:

```ts
traceAsyncChannel(providerChannels.create, {
  name: "provider.messages.create",
  type: "llm",
  extractInput(args) {
    return {
      input: args[0].messages,
      metadata: { model: args[0].model },
    };
  },
  extractOutput(result) {
    return result.content;
  },
  extractMetrics(result) {
    return {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
    };
  },
});
```

The helpers:

- create and correlate spans with a `WeakMap` keyed by event context
- bind the current span store to `start` for async-context propagation
- contain extraction failures and log them through `debugLogger`
- patch streams without replacing their public semantics
- install process-lifetime subscriptions and span-store bindings

Use raw `IsoChannelHandlers` only when a provider requires lifecycle behavior
that the shared helpers cannot express.

## Manual Wrappers

New and migrated manual wrappers pass the original target, receiver, arguments,
and any channel-specific fields to the same typed channel:

```ts
return providerChannels.create.invoke(originalCreate, this, [params], {
  providerRequestId,
});
```

Legacy wrappers can continue calling the tracing-compatible operators until
their consumer is migrated:

```ts
return providerChannels.create.tracePromise(() => originalCreate(params), {
  arguments: [params],
});
```

Do not create spans directly inside wrappers. Keeping span creation in the
internal consumer prevents auto and manual instrumentation from drifting.

## Promise and Stream Requirements

Instrumentation is non-invasive:

- Native promises retain normal resolution and rejection behavior.
- Promise subclasses and other thenables are returned unchanged so helper
  methods such as `withResponse()` remain available.
- A non-Promise value returned from an `Async` transform remains that value.
- Async iterables and event-emitter streams retain identity and public methods.
- Subscriber or extraction bugs must not alter provider calls.

Stream patches must be idempotent and preserve cancellation, errors, early
termination, and async context.

## Event and Span Safety

- Treat arguments, results, metadata, and headers as untrusted.
- Avoid prototype-sensitive merges and unnecessary mutation of provider data.
- Capture only fields permitted by the instrumentation specification.
- Pass `Error` objects directly to `span.log({ error })`.
- Use narrow vendored provider interfaces shared by wrappers and consumers.
- Keep enable, subscription, and patching behavior idempotent.

## Testing

Test at the narrowest useful layers:

1. Consumer unit tests for extraction and span handling.
2. Global hook/runtime tests for lifecycle and context behavior.
3. Orchestrion transformation tests for generated wrappers.
4. Bundler and loader tests for real transformed execution.
5. Provider e2e tests for wrapped and auto-hook parity.

After instrumentation changes, run e2e tests in cassette replay mode. When an
e2e scenario itself changes, run it three times to catch flakes.
