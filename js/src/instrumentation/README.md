# Writing Braintrust Instrumentation Plugins

Braintrust instrumentation plugins consume tracing-compatible events from the
internal global hook registry and convert them into spans. Auto-instrumented
provider code and manual wrappers use the same typed channels, so extraction,
stream handling, and span behavior stay aligned.

## Architecture

An instrumentation has four parts:

1. An Orchestrion config identifies the provider function for automatic
   transformation.
2. A typed channel defines its arguments, result, extra event fields, and stable
   `orchestrion:<package>:<operation>` identifier.
3. A plugin subscribes to that channel and maps events into Braintrust spans.
4. A manual wrapper invokes the same typed channel when transformation is not
   available.

The global hook transport is internal. Plugins should use `defineChannels`,
`traceAsyncChannel`, `traceStreamingChannel`, `traceSyncStreamChannel`, or
`BasePlugin` helpers rather than reading the global property directly.

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

The generated wrapper creates `arguments`, `self`, and `moduleVersion`.
Tracing operators add `result` or `error`.

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
this.register(
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
  }),
);
```

The helpers:

- create and correlate spans with a `WeakMap` keyed by event context
- bind the current span store to `start` for async-context propagation
- contain extraction failures and log them through `debugLogger`
- patch streams without replacing their public semantics
- unsubscribe and unbind stores when a plugin is disabled

Use raw `IsoChannelHandlers` only when a provider requires lifecycle behavior
that the shared helpers cannot express.

## Manual Wrappers

Manual wrappers call the same typed channel:

```ts
return providerChannels.create.tracePromise(() => originalCreate(params), {
  arguments: [params],
});
```

Do not create spans directly inside wrappers. Keeping span creation in the
plugin prevents auto and manual instrumentation from drifting.

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
- Use narrow vendored provider interfaces shared by wrappers and plugins.
- Keep enable, disable, subscription, and patching behavior idempotent.

## Testing

Test at the narrowest useful layers:

1. Plugin unit tests for extraction and span handling.
2. Global hook/runtime tests for lifecycle and context behavior.
3. Orchestrion transformation tests for generated wrappers.
4. Bundler and loader tests for real transformed execution.
5. Provider e2e tests for wrapped and auto-hook parity.

After instrumentation changes, run e2e tests in cassette replay mode. When an
e2e scenario itself changes, run it three times to catch flakes.
