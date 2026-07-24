# Braintrust Auto-Instrumentation

Braintrust auto-instrumentation uses the vendored Orchestrion-JS transformer to
wrap selected AI SDK functions at load time or bundle time. Transformed code
invokes tracing-compatible hooks stored in a shared global registry; it does not
import or publish Node.js `diagnostics_channel` events.

## Instrumentation Configs

Each config identifies a package file and function:

```ts
const config = {
  channelName: "chat.completions.create",
  module: {
    name: "openai",
    versionRange: ">=4.0.0 <7.0.0",
    filePath: "resources/chat/completions.mjs",
  },
  functionQuery: {
    className: "Completions",
    methodName: "create",
    kind: "Async",
  },
};
```

`channelName` omits the prefix. Orchestrion constructs the stable identifier:

```text
orchestrion:<module.name>:<channelName>
```

The corresponding typed channel definition and plugin subscription must use the
same identifier.

## Generated Runtime Contract

For every configured channel, transformed modules lazily look up:

```js
globalThis.__braintrust_instrumentation_hooks?.get(
  "orchestrion:openai:chat.completions.create",
);
```

The lookup is retried until a hook exists, then cached. This has two important
properties:

- Loading an instrumented provider before Braintrust is safe; calls run normally.
- Registering Braintrust later enables tracing without retransformation.

When a hook has no subscribers, the original function is called directly.
Otherwise the generated wrapper invokes `tracePromise`, `traceSync`, or
`traceCallback` with a context containing the original `arguments`, `self` when
available, and `moduleVersion`.

The hook lifecycle mirrors tracing channels:

1. `start` before the target call
2. `end` after its synchronous portion
3. `asyncStart` and `asyncEnd` when an asynchronous result settles
4. `error` for synchronous throws, promise rejections, or callback errors

The same context object is passed through every phase. Subscribers may mutate
arguments or returned streams before user code continues.

## Global Registry

The SDK installs `globalThis.__braintrust_instrumentation_hooks` with a
non-enumerable, non-writable property descriptor. Its value is a mutable
`Map<string, TracingHook>` shared by all Braintrust SDK copies in the realm.

The implementation lives in `src/global-instrumentation-hooks.ts`. It supports:

- all five lifecycle phases
- multiple subscribers and complete unsubscription
- `bindStore` / `unbindStore` for async-context propagation
- sync, promise, and callback tracing operators
- preservation of Promise subclasses, thenables, and non-Promise return values

Manual wrappers use the same registry through typed channel definitions, so
manual and auto-instrumented paths share lifecycle and span behavior.

## Loaders and Bundlers

The unified Node hook instruments ESM and CJS:

```bash
node --import braintrust/hook.mjs app.mjs
```

Bundler integrations are available for esbuild, Vite, Rollup, Webpack, Next.js,
and Turbopack. Generated provider code is runtime-independent and contains no
Node built-in or browser-shim import.

`useDiagnosticChannelCompatShim` remains accepted by the public bundler options
for source compatibility. It no longer changes the hook transport; it only
retains the legacy browser-target hint used to skip Node-specific special-case
patches.

## Adding an Instrumentation

1. Add the narrowest supported package/version/file/function config under
   `configs/`.
2. Define a typed channel with the same package and operation identifier.
3. Add or update a plugin that subscribes through the shared channel helpers.
4. Keep manual wrappers on that same typed channel.
5. Add transformation/runtime coverage and a provider e2e scenario when the
   user-visible trace contract changes.

Instrumentation must preserve target behavior, including receivers, argument
mutation, errors, async context, streams, and custom Promise APIs.

## Testing

Relevant suites live in:

- `src/global-instrumentation-hooks.test.ts`
- `tests/auto-instrumentations/orchestrion-js-upstream.test.ts`
- `tests/auto-instrumentations/transformation.test.ts`
- `tests/auto-instrumentations/runtime-execution.test.ts`
- `tests/auto-instrumentations/loader-hook.test.ts`

The transformation suites assert that output contains the global registry lookup
and contains neither `diagnostics_channel` nor `dc-browser`. Provider e2e tests
must run in cassette replay mode after instrumentation changes.
