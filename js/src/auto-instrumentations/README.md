# Braintrust Auto-Instrumentation

Braintrust auto-instrumentation uses the vendored Orchestrion-JS transformer to
wrap selected AI SDK functions at load time or bundle time. Transformed code
uses hooks stored in a shared global registry.

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

Generated wrappers lazily look up invocation hooks in `globalThis.__braintrust_invocation_hooks_v2`.
They pass the original target, receiver, complete arguments, and module version to `invoke`.
They do not emit tracing events, create spans, or select tracing operators.
Legacy `functionQuery.kind` and `callbackIndex` fields remain accepted for source compatibility but do not select runtime tracing behavior.

Calls run normally before a hook is registered.
Lookup retries until registration succeeds, then caches the hook.
Interceptors compose in registration order and may replace arguments, receivers, results, or the complete implementation.

## Global Registry

The invocation registry is a non-enumerable, non-writable global property containing a shared map.
It is independent of SDK initialization, async-context storage, and tracing.
Manual wrappers use the same hooks through `defineInterceptor` and `invoke`.
Provider plugins explicitly register separate tracing functions through `intercept`.
Do not combine wrapping and tracing in a runtime or convenience API.

Protocol version 2 uses a separately keyed registry so it does not mutate an older SDK's registry.
Previously transformed bundles must be rebuilt with the updated SDK to retain instrumentation.
There is no legacy tracing-event compatibility layer.

## Loaders and Bundlers

The unified Node hook instruments ESM and CJS:

```bash
node --import braintrust/hook.mjs app.mjs
```

Bundler integrations are available for esbuild, Vite, Rollup, Webpack, Next.js,
and Turbopack. Generated provider code is runtime-independent and contains no
Node built-in or browser-shim import.

Bundler plugins accept `browser: true` when their output targets a browser or
edge-like runtime. Global hooks themselves are runtime-independent; this hint
only prevents the Node-specific Mastra source patch from entering those
bundles.

## Adding an Instrumentation

1. Add the narrowest supported package/version/file/function config under
   `configs/`.
2. Define a typed channel with the same package and operation identifier.
3. Write a separate tracing function and explicitly register it through `intercept` in the provider plugin.
4. Keep manual wrappers on that same typed channel through `invoke`.
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
