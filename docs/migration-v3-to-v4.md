# Upgrading from Braintrust JavaScript SDK v3 to v4

Version 4 removes deprecated APIs and changes logging, attachment capture, and trace propagation.
The behavior changes below can affect applications even when their code still type-checks.

## 1. Version support changes

### Package versions

Use these major versions with SDK v4.
When upgrading `braintrust`, also upgrade the companion packages your application already uses:

| Package                             | Major version for SDK v4 |
| ----------------------------------- | ------------------------ |
| `braintrust`                        | 4.x                      |
| `@braintrust/otel`                  | 2.x                      |
| `@braintrust/temporal`              | 2.x                      |
| `@braintrust/browser`               | 2.x                      |
| `@braintrust/deepseek-harness`      | 2.x                      |
| `@braintrust/templates-nunjucks-js` | 2.x                      |
| `@braintrust/audio`                 | 1.x                      |

### Runtime and provider versions

**Node.js:** The minimum supported version is now **22.18.0** for these packages:

- `braintrust`
- `@braintrust/audio`
- `@braintrust/browser`
- `@braintrust/deepseek-harness`
- `@braintrust/otel`
- `@braintrust/templates-nunjucks-js`
- `@braintrust/temporal`

This drops support for Node 18, Node 20, Node 21, and Node 22 versions before 22.18.0.

**Browsers and edge runtimes:** SDK builds now target ES2022.
If you support older runtimes, include the SDK in your application's transpilation step.

**Provider libraries:** Support for the following versions has been removed:

- Vercel AI SDK (`ai`) v3; upgrade to v4 or newer.
- Eve versions before v0.34.0; upgrade to v0.34.0 or newer.
- Flue versions before v1; upgrade to v1 or newer.

## 2. Behavior changes

### Instrumentation registration

Importing `braintrust` no longer registers all provider integrations.
This allows bundlers to remove unused integrations from your application.

Keep your Braintrust bundler plugin configured.
The Vite, Webpack, Rollup, esbuild, and Next.js integrations automatically insert an import of `braintrust/auto` into instrumented provider modules, so no extra startup import is required.
`braintrust/auto` registers the integrations that handle instrumented calls; the bundler plugin transforms provider code.

The Node.js entrypoints `braintrust/hook.mjs` and `braintrust/apply-auto-instrumentation` already register integrations.
Manual wrappers such as `wrapOpenAI()` and `wrapAISDK()` register their own integrations when called.

Call `configureInstrumentation()` before loading `braintrust/auto`, the Node.js instrumentation entrypoints, or calling a wrapper.
With bundler auto-instrumentation, static provider imports can load the injected `braintrust/auto` before your startup code runs.
Configuration after any integration has registered is ignored.
Configure instrumentation in a startup module, then dynamically import the application module that imports and uses provider libraries:

```ts
import { configureInstrumentation } from "braintrust/instrumentation";

configureInstrumentation({ integrations: { openai: false } });
await import("./app.js");
```

### Logging and flushing

The `asyncFlush` option has been removed from `initLogger`, `currentLogger`, `startSpan`, `traced`, and `wrapTraced`.
The `logger.asyncFlush` getter has also been removed.
Remove conditions that read this property, and explicitly await `logger.flush()` wherever uploads must finish.
Logs are now always uploaded in the background.
If you previously used `asyncFlush: false`, call and await `flush()` where you need to wait for uploads:

```diff
- const logger = initLogger({ projectName: "my-project", asyncFlush: false });
- await logger.log({ input: "hello", output: "world" });
+ const logger = initLogger({ projectName: "my-project" });
+ logger.log({ input: "hello", output: "world" });
+ await logger.flush();
```

Awaiting a log call or traced function does not wait for its logs to upload.
Use `logger.flush()` to flush that logger's state, or `flush()` from `braintrust` to flush the default state.
For OpenTelemetry spans, also flush your OpenTelemetry provider or processor; these native SDK flush methods do not drain its queue.
For short-lived processes, await flushing before exiting.

`logger.log()` now always returns a string ID.
`traced`, `logger.traced`, and `wrapTraced` return a synchronous value for synchronous callbacks and a promise for asynchronous callbacks.
If your code calls `.then()` on a wrapped synchronous function, update it to use the returned value directly.

### Attachment capture

Instrumentation no longer captures inline images, audio, video, or files by default.
To continue capturing these as attachments, set `autoCaptureAttachments: true` when initializing the logger:

```ts
initLogger({
  projectName: "my-project",
  autoCaptureAttachments: true,
});
```

You can also enable capture with the `BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS` environment variable, set to `true` or `1`.
The old names `captureAttachments` and `BRAINTRUST_CAPTURE_ATTACHMENTS` are no longer supported.
An explicit `autoCaptureAttachments` option overrides the environment variable, including when set to `false`.
For current loggers (`setCurrent: true`, the default), an explicit option also sets the state's default capture policy.
Later current loggers that omit the option retain that setting.
Set `autoCaptureAttachments: false` explicitly to disable capture after it was enabled.
Child spans inherit the policy.
Loggers created with `setCurrent: false` have an independent policy and use the environment variable when the option is omitted.

`init()` and `Eval()` do not accept an `autoCaptureAttachments` option.
For experiments and evals, set `BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS=true` before creating spans, or use the state's default capture policy configured by a current logger as described above.
An explicit state policy takes precedence over the environment variable.

With capture disabled, inline media payloads are omitted from logged inputs and outputs.
Text, remote URLs, and file references can still appear in traces.
Explicitly logged `Attachment`, `ExternalAttachment`, and `JSONAttachment` objects are unaffected by this option.

This also applies to `@braintrust/deepseek-harness`, which accepts `autoCaptureAttachments` in its configuration.

### Trace propagation

The public `parent` argument on span APIs and `withParent()` no longer accepts serialized strings from `span.export()`.
Use W3C trace headers and `extractTraceContextFromHeaders()` instead:

```diff
  // Sender
- const parent = await span.export();
+ const headers = span.inject();

  // Receiver: forward the sender's headers with the request.
- const parent = request.headers.get("x-braintrust-parent");
+ const parent = extractTraceContextFromHeaders(request.headers);
  const child = startSpan({ name: "handler", parent });
```

Forward `traceparent`, `tracestate`, and `baggage` together to preserve trace identity and Braintrust routing.
`injectTraceContext()` provides the headers for the current span.
Within one process, use `span.startSpan()`, `span.traced()`, or `withCurrent()` to create child spans.

`span.export()` remains available for APIs that explicitly accept exported identifiers, such as `invoke()`.

**Experiment destinations**

An experiment's ID must be resolved before its spans can inject the destination into `baggage`.
Unlike `await span.export()`, `span.inject()` is synchronous and does not wait for that ID.
For a span in a newly initialized experiment, resolve its destination before injecting headers:

```ts
await span.export();
const headers = span.inject();
```

Send the injected headers to the receiver.
Without the destination, the receiver can route the span to its own logger or experiment, or fail to continue the trace.

**Legacy IDs**

Unset `BRAINTRUST_LEGACY_IDS` before starting spans that need W3C propagation.
Legacy UUIDs cannot be encoded as W3C trace IDs and span IDs, so `span.inject()` and `injectTraceContext()` emit no trace headers for those spans.
If `BRAINTRUST_OTEL_COMPAT` is enabled, it overrides the legacy-ID setting and selects W3C-compatible hex IDs.

**Distributed evals**

`span.export()` disables the local span cache because remote spans are not stored in it.
`span.inject()` and `injectTraceContext()` do not disable that cache.
If your eval calls another service and scorers read its spans through `trace.getSpans()`, set `enableCache: false` in the third argument to `Eval()`:

```ts
await Eval("my-project", evaluator, {
  enableCache: false,
});
```

Otherwise, scorers can receive only locally cached spans and miss remote children.
Ensure that the remote service flushes its spans before scoring starts.

**Propagated metadata and tags**

Exported span strings include `propagatedEvent`, but the W3C headers do not serialize it.
If you use `propagatedEvent` to inherit metadata or tags across services, send that data separately in your application's request payload.
On the receiver, pass the received data as `propagatedEvent` alongside the extracted `parent`, for example `startSpan({ name: "handler", parent, propagatedEvent })`.
The receiving span and its descendants then inherit that data.

### Dataset records

The `useOutput` option on `initDataset()` has been removed.
Dataset records now use `expected` for the expected output, including when reading existing records stored in the legacy format.
Replace reads of `record.output` with `record.expected`, and update insert calls:

```diff
- dataset.insert({ input: "hello", output: "world" });
+ dataset.insert({ input: "hello", expected: "world" });
```

### Eval results

`Eval()` now returns a plain object with `summary` and `results` fields instead of an `EvalResultWithSummary` instance.
The custom `toString()` and `toJSON()` methods have been removed.
Read the fields directly, or use `JSON.stringify(result.summary)` to serialize the summary.

### Temporal

`@braintrust/temporal` now propagates `traceparent`, `tracestate`, and `baggage` instead of the `_braintrust-span` and `_braintrust-workflow-span*` headers.
Upgrade clients and workers together.
The new integration does not read the old headers, so mixed versions can lose parent trace links.

## 3. Package and CLI changes

### CLI installation

The `braintrust` package no longer includes the JavaScript `braintrust` CLI or installs the `bt` binary.
Install `bt` separately in development and CI using the [CLI installation instructions](https://www.braintrust.dev/docs/reference/cli/quickstart).

```diff
- npx braintrust eval example.eval.ts
+ bt eval example.eval.ts
```

For function push/pull scripts, use `bt functions push` and `bt functions pull`.
See the [function CLI reference](https://www.braintrust.dev/docs/reference/cli/functions) for their flags.

Lambda sandbox registration is an exception: `bt` has no Lambda sandbox registration command.
Keep a separate registration project or setup environment on TypeScript SDK v3 for that step, with eval code and dependencies compatible with v3, and run its `npx braintrust push` command there.
The migrated application can keep SDK v4.
See [Register your sandbox](https://www.braintrust.dev/docs/evaluate/remote-evals#2-register-your-sandbox) for the registration steps.
Modal sandbox registration through `registerSandbox()` remains available in SDK v4.

### Removed integration packages

The following packages will no longer be published:

- **`@braintrust/langchain-js`:** Use `BraintrustLangChainCallbackHandler` from `braintrust` and pass it through LangChain's `callbacks` option.
  For application-wide tracing, replace `setGlobalHandler` with auto-instrumentation.

- **`@braintrust/openai-agents`:** Import `OpenAIAgentsTraceProcessor` from `braintrust/instrumentation` and register it with OpenAI Agents' `addTraceProcessor`, or use auto-instrumentation.

- **`@braintrust/vercel-ai-sdk`:** Replace `BraintrustAdapter` and its `toAIStream`, `toAIStreamResponse`, and `toDataStreamResponse` methods with `BraintrustStream` and your AI SDK version's stream/response APIs.
  This requires adapting the stream format, not just changing the import.

### Removed package entrypoints

- `braintrust/browser` has been removed.
  Import from `braintrust` with browser export conditions, or use `@braintrust/browser` for its context propagation integration.
- `braintrust/dev` and `braintrust/util` have been removed.
  Use the public SDK APIs or application-owned utilities instead.
- `braintrust/webpack-loader` has been removed as a public entrypoint.
  Use `braintrustWebpackPlugin` from `braintrust/webpack`, or `wrapNextjsConfigWithBraintrust` from `braintrust/next`.

## 4. Removed and changed APIs

### Core SDK

- The default export has been removed.
  Use named imports or a namespace import:

  ```diff
  - import braintrust from "braintrust";
  + import * as braintrust from "braintrust";
  ```

- The string-first overloads of `init()` and `initDataset()` have been removed.
  Pass the project name in the options object:

  ```diff
  - const experiment = init("my-project", { experiment: "my-experiment" });
  + const experiment = init({ project: "my-project", experiment: "my-experiment" });

  - const dataset = initDataset("my-project", { dataset: "my-dataset" });
  + const dataset = initDataset({ project: "my-project", dataset: "my-dataset" });
  ```

- `initExperiment()` has been removed.
  Use `init()` instead.
- `withExperiment()`, `withLogger()`, and `withDataset()` have been removed.
  Create the object with `init()`, `initLogger()`, or `initDataset()` and use it directly.
- The top-level `log()` and `summarize()` functions have been removed.
  Use `experiment.log()` and `experiment.summarize()` instead.
- `traceable()` has been removed.
  Use `wrapTraced()` instead.
- `wrapOpenAIv4()` has been removed.
  Use `wrapOpenAI()` instead.
- `Span.close()` has been removed.
  Use `span.end()` instead.
- `Experiment.close()` and `Dataset.close()` have been removed.
  These methods were no-ops and their calls can be removed.
  If you used the returned ID, use `await experiment.id` or `await dataset.id`.
  Use `flush()` when you need to wait for uploads.
- The top-level `permalink()` function has been removed.
  Use `await span.permalink()` or `span.link()` instead.
- The `orgProjectMetadata` option on `initLogger()` has been removed without replacement.

### Logging and eval fields

- The `inputs` field on log events has been removed.
  Use `input` instead.
- The `datasetRecordId` field on log events has been removed.
  Use `origin` to reference the source dataset record:

  ```diff
  - datasetRecordId: recordId,
  + origin: { object_type: "dataset", object_id: datasetId, id: recordId },
  ```

  Include `_xact_id` in `origin` when referencing a specific record version.

- The `meta()` method on eval task hooks has been removed.
  Update `hooks.metadata` directly:

  ```diff
  - hooks.meta({ language: "en" });
  + hooks.metadata.language = "en";
  ```

- The `error` field on scorer results has been removed.
  Throw the error from the scorer instead.
- `runEvaluator()`, `buildLocalSummary()`, and `reportFailures()` have been removed.
  Use `Eval()` and its result, with `Reporter()` for custom reporting.

### Instrumentation

The following exports have moved from `braintrust` to `braintrust/instrumentation`:

- `configureInstrumentation`
- `InstrumentationConfig`
- `SpanCustomizer`
- `SpanExportData`
- `registerOtelFlush`
- `braintrustEveInstrumentation`
- `braintrustFlueInstrumentation`

```diff
- import { configureInstrumentation } from "braintrust";
+ import { configureInstrumentation } from "braintrust/instrumentation";
```

The following aliases in `configureInstrumentation({ integrations: … })` have been removed:

- `vercel`: Use `aisdk`.
- `google`: Use `googleGenAI`.
- `cursor`: Use `cursorSDK`.
- `bedrock` and `awsBedrock`: Use `awsBedrockRuntime`.
- `flue`: Register `braintrustFlueInstrumentation()` explicitly as described below.

Environment-variable aliases continue to map to the canonical keys, except for the removed Flue aliases.

`BasePlugin`, `BraintrustPlugin`, `BraintrustPluginConfig`, channel-name helpers, and channel lifecycle types have been removed from the public API.
Use `configureInstrumentation()` to configure built-in integrations, and `traced()` or `wrapTraced()` for custom tracing.

### Bundler plugins

The deprecated plugin names have been removed:

- `esbuildPlugin`: Use `braintrustEsbuildPlugin` from `braintrust/esbuild`.
- `rollupPlugin`: Use `braintrustRollupPlugin` from `braintrust/rollup`.
- `vitePlugin`: Use `braintrustVitePlugin` from `braintrust/vite`.
- `webpackPlugin`: Use `braintrustWebpackPlugin` from `braintrust/webpack`.

The `useDiagnosticChannelCompatShim` option has been removed.
Use `browser` instead.

### Vercel AI SDK

`BraintrustMiddleware` and `wrapAISDKModel()` have been removed.
Use `wrapAISDK()` or auto-instrumentation instead.
For module wrapping, pass the original model to the wrapped SDK functions:

```ts
import * as ai from "ai";
import { wrapAISDK } from "braintrust";

const { generateText, streamText } = wrapAISDK(ai);
```

### Mastra

`wrapMastraAgent()` has been removed.
It was a no-op.
Use `BraintrustObservabilityExporter` in Mastra's observability configuration, or auto-instrumentation.

### Eve

`braintrustEveHook` and the legacy hook-file integration have been removed.
Configure `braintrustEveInstrumentation()` from `braintrust/instrumentation` through Eve's instrumentation configuration instead.

### Flue

`braintrustFlueObserver` and the legacy loader/CLI integration have been removed.
Register the integration explicitly:

```ts
import { instrument } from "@flue/runtime";
import { braintrustFlueInstrumentation } from "braintrust/instrumentation";

instrument(braintrustFlueInstrumentation());
```

### OpenTelemetry

`@braintrust/otel` no longer depends on a specific OpenTelemetry SDK or exporter version.
It supports OpenTelemetry SDK 1, 2, and 3 through the same package entrypoint.
Install mutually compatible SDK, processor, and exporter packages for your chosen version; `@opentelemetry/api` remains a peer dependency at `^1.9.0`.
Update `@braintrust/otel` alongside the core Braintrust SDK.

`BraintrustSpanProcessor` now requires a `processor` instance, and `BraintrustExporter` requires an `exporter` instance.
They no longer create an OTLP exporter or batch processor internally.
Move `apiKey`, `apiUrl`, `parent`, and `headers` from their constructors to `braintrustOtlpConfig()`, which synchronously returns the URL and headers for your OTLP/HTTP exporter.
Replace the internal `_spanProcessor` option with `processor`.

For OpenTelemetry SDK 1 and 2:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
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
  processor: new BatchSpanProcessor(exporter),
});
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();
```

For OpenTelemetry SDK 3, import `BatchSpanProcessor` from `@opentelemetry/sdk-trace` and construct it with `new BatchSpanProcessor({ exporter })` instead.
The Braintrust adapter constructors stay the same.

`braintrustOtlpConfig()` requires an API key and an explicit project or experiment through `parent` or `BRAINTRUST_PARENT`, for example `project_name:my-project`, `project_id:<id>`, or `experiment_id:<id>`.
The API key defaults to `BRAINTRUST_API_KEY`, then the nearest `.env.braintrust` file in Node.js.
Missing credentials or routing now throw during setup; there is no implicit default project.
The helper does not create a project or register an OpenTelemetry provider.
For a plain OTLP pipeline, you can pass its result directly to your exporter without either Braintrust adapter.

Keep `filterAISpans`, `customFilter`, and `environment` on the Braintrust adapters.
Configure filtering on one adapter to avoid evaluating your filter twice.
Export customization now runs in `BraintrustExporter`; `BraintrustSpanProcessor` alone does not apply registered span customizers.
Wrap the transport with `BraintrustExporter` when you use `configureInstrumentation({ spanCustomizers: [...] })`.
For Next.js Edge, use `OTLPHttpJsonTraceExporter` from `@vercel/otel` as the downstream exporter; it uses `fetch` instead of the `XMLHttpRequest` required by the standard OTel browser exporter.

The application now owns batching, queue limits, export timeouts, and provider shutdown.
Flush the provider or processor to drain queued spans.
`BraintrustExporter.forceFlush()` waits for batches already received and flushes its downstream exporter when supported; it cannot drain an upstream processor's queue.
It no longer batches spans again or forces a transport flush after every export.

Each `BraintrustSpanProcessor` registers its flush callback with Braintrust and removes it on shutdown.
All registered callbacks run when Braintrust flushes OpenTelemetry spans, including before scorer queries.
`registerOtelFlush()` now returns an unregister function instead of replacing the previous callback.
If you use a plain OTLP pipeline without `BraintrustSpanProcessor`, register your provider explicitly so Braintrust can flush it before querying spans:

```ts
import { registerOtelFlush } from "braintrust/instrumentation";

const unregister = registerOtelFlush(() => provider.forceFlush());
// During application shutdown:
unregister();
await provider.shutdown();
```

For mixed native Braintrust and OpenTelemetry traces, register your OpenTelemetry provider and context manager before calling `setupOtelCompat()`.
The bridge now uses public OpenTelemetry context APIs and requires a registered context manager for asynchronous propagation.
Sampling flags and trace state are preserved across native and OpenTelemetry spans.
`resetOtelCompat()` restores Braintrust's default context manager.

- `contextFromSpanExport()` from `@braintrust/otel` has been removed.
  Use `contextFromSpan(span)` instead of `contextFromSpanExport(await span.export())`.
  For remote parents, propagate W3C headers.
- `parentFromHeaders()` now returns `PropagationContext | undefined` instead of an exported span string.

### Custom context managers

- For custom context managers, use `configureContextManager(YourContextManager)` instead of mutating internal state or globals.
  Replace the `BRAINTRUST_CURRENT_SPAN_STORE` symbol property with `getCurrentSpanStore()`.
  Pass `undefined` to `configureContextManager()` to restore the default.
- The `BRAINTRUST_ID_GENERATOR` and `BRAINTRUST_SPAN_COMPONENT` globals are no longer used, and ID-generator exports have been removed.
  The SDK uses its default IDs; `BRAINTRUST_LEGACY_IDS` remains available for legacy UUIDs.
  See [Trace propagation](#trace-propagation) for the W3C limitations of legacy UUIDs.
- `@braintrust/browser` now installs its context manager through `configureContextManager()`.
  Update it alongside the core SDK.

### Project builders and internal APIs

- `Project`, `CodeFunction`, `CodePrompt`, `ProjectNameIdMap`, `ToolBuilder`, `ScorerBuilder`, and `PromptBuilder` are no longer exported.
  Use `projects.create()` and its `tools`, `scorers`, `prompts`, and other builder properties to define functions.
- `graph` has been removed without replacement.
- `SpanFetcher` and `CachedSpanFetcher` are no longer exported.
  Access spans through `Trace` or `LocalTrace` methods.
- `templateRegistry`, `getTemplateRenderer()`, `renderMessage()`, and `renderPromptParams()` are no longer exported.
  Use `registerTemplatePlugin()` for template extensions and `Prompt.build()` for rendering.
- Stream helpers and runtime schemas are no longer exported.
  Use `BraintrustStream` for streaming and define application-specific validation in your application.
- `NoopSpan` is no longer exported.
  Use `NOOP_SPAN` instead.
- `_internalSerializeForCache()` has been removed from `Prompt` and loaded parameters without a public replacement.
- Logging internals, testing helpers, and low-level utilities are no longer exported.
  The complete list of removed root exports is included below.

## 5. Type changes

- `Logger` and `Dataset` no longer accept boolean type arguments.
  Replace `Logger<true>` / `Logger<false>` with `Logger`, and `Dataset<true>` / `Dataset<false>` with `Dataset`.
- Flush-related type arguments have also been removed from tracing functions, `BraintrustLangChainCallbackHandler`, and its options type.
  For example, `traced<true, Result>` becomes `traced<Result>`.
- Eval task callbacks now use a single `(input, hooks) => Output | Promise<Output>` signature.
  Async-generator data sources remain supported through `AsyncIterable`.
- Most request, result, metadata, and configuration types are no longer named exports, including the bundler `EsbuildPluginOptions`, `RollupPluginOptions`, `VitePluginOptions`, and `WebpackPluginOptions` types.
  Remove these imports and annotations, and pass values directly to SDK functions.
- Public declarations now use SDK-owned TypeScript contracts instead of backend-generated or Zod-inferred types.
  Supplying Zod schemas for eval and function parameters remains supported.

## 6. Build changes

- `braintrust`, `@braintrust/otel`, `@braintrust/temporal`, `@braintrust/deepseek-harness`, and `@braintrust/templates-nunjucks-js` now publish ESM instead of separate CommonJS and ESM builds.
  `@braintrust/browser` remains ESM.
  Configure your bundler and test runner to load ESM dependencies.
  CommonJS applications can use dynamic `import()` when their loader cannot load ESM through `require()`:

  ```js
  const { initLogger } = await import("braintrust");
  ```

  In CommonJS, put this call inside an async function.

- The SDK now preserves module boundaries so bundlers can remove unused features, including evals, datasets, prompts, and provider integrations.
  Continue importing public APIs from `braintrust`; use `braintrust/auto` when registering all integrations as described above.

- Runtime selection now uses the package's `exports` conditions (`workerd`, `edge-light`, `browser`, and `node`).
  The fallback is the browser build, and the legacy `browser` field has been removed.
  If you customize module resolution, ensure it honors these conditions; use `braintrust/node`, `braintrust/workerd`, or `braintrust/edge-light` when explicitly selecting a runtime.

- Built file locations have changed, including the former `dist/index.js` and `dist/index.mjs` files.
  Replace direct `dist` imports or aliases with public package entrypoints such as `braintrust` and `braintrust/hook.mjs`.

<details>
<summary>Complete index of names no longer exported from the root <code>braintrust</code> module</summary>

This includes types and names moved to `braintrust/instrumentation`; use the replacements above.

- `_exportsForTestingOnly`
- `_internalGetGlobalState`
- `_internalIso`
- `_internalSetInitialState`
- `addAzureBlobHeaders`
- `AnyDataset`
- `AttachmentParams`
- `AttachmentReference`
- `BackgroundLoggerOpts`
- `BAGGAGE_HEADER`
- `BaseMetadata`
- `BRAINTRUST_CURRENT_SPAN_STORE`
- `BRAINTRUST_LANGCHAIN_CALLBACK_HANDLER_NAME`
- `BRAINTRUST_PARENT_KEY`
- `braintrustEveHook`
- `braintrustEveInstrumentation`
- `braintrustFlueInstrumentation`
- `braintrustFlueObserver`
- `BraintrustMiddleware`
- `BraintrustStreamChunk`
- `braintrustStreamChunkSchema`
- `buildLocalSummary`
- `CachedSpanFetcher`
- `ChatPrompt`
- `CodeFunction`
- `CodeOpts`
- `CodePrompt`
- `CommentEvent`
- `CompiledPrompt`
- `CompiledPromptParams`
- `CompletionPrompt`
- `configureInstrumentation`
- `constructLogs3OverflowRequest`
- `createFinalValuePassThroughStream`
- `CreateProjectOpts`
- `DatasetRecord`
- `DatasetRestorePreviewResult`
- `DatasetRestoreResult`
- `DatasetSnapshot`
- `DatasetSummary`
- `DataSummary`
- `deepCopyEvent`
- `DEFAULT_FETCH_BATCH_SIZE`
- `DEFAULT_MAX_REQUEST_SIZE`
- `DefaultMetadataType`
- `DefaultPromptArgs`
- `deserializePlainStringAsJSON`
- `devNullWritableStream`
- `EndSpanArgs`
- `ERR_PERMALINK`
- `EvalCase`
- `EvalHooks`
- `EvalParameters`
- `EvalParameterSerializedSchema`
- `EvalResult`
- `EvalResultWithSummary`
- `EvalScorerArgs`
- `EvaluatorDef`
- `EvaluatorDefinition`
- `EvaluatorDefinitions`
- `evaluatorDefinitionSchema`
- `evaluatorDefinitionsSchema`
- `EvaluatorFile`
- `EvaluatorManifest`
- `ExperimentLogFullArgs`
- `ExperimentLogPartialArgs`
- `ExperimentSummary`
- `Exportable`
- `ExternalAttachmentParams`
- `FailedHTTPResponse`
- `FullInitDatasetOptions`
- `FullInitOptions`
- `FullLoginOptions`
- `FunctionEvent`
- `getContextManager`
- `getIdGenerator`
- `getSpanParentObject`
- `getTemplateRenderer`
- `GetThreadOptions`
- `graph`
- `IdField`
- `IDGenerator`
- `InitDatasetOptions`
- `initExperiment`
- `InitLoggerOptions`
- `InitOptions`
- `InputField`
- `InstrumentationConfig`
- `InvokeFunctionArgs`
- `InvokeReturn`
- `LazyValue`
- `LEGACY_CACHED_HEADER`
- `LoadPromptOptions`
- `log`
- `LogCommentFullArgs`
- `LogFeedbackFullArgs`
- `LoginInvalidOrgError`
- `LoginOptions`
- `LogOptions`
- `LOGS3_OVERFLOW_REFERENCE_TYPE`
- `Logs3OverflowInputRow`
- `Logs3OverflowUpload`
- `logs3OverflowUploadSchema`
- `MastraObservabilityExporter`
- `MetricSummary`
- `newId`
- `NOOP_SPAN_PERMALINK`
- `NoopSpan`
- `ObjectFetcher`
- `ObjectMetadata`
- `OTELIDGenerator`
- `OtherExperimentLogFields`
- `ParametersSource`
- `ParentExperimentIds`
- `ParentProjectLogIds`
- `parseCachedHeader`
- `ParsedTraceparent`
- `permalink`
- `pickLogs3OverflowObjectIds`
- `Project`
- `ProjectNameIdMap`
- `PromiseUnless`
- `PromptBuilder`
- `PromptContents`
- `promptContentsSchema`
- `PromptDefinition`
- `promptDefinitionSchema`
- `promptDefinitionToPromptData`
- `PromptDefinitionWithTools`
- `promptDefinitionWithToolsSchema`
- `PromptOpts`
- `PromptRowWithId`
- `PropagatedState`
- `registerOtelFlush`
- `RegisterSandboxOptions`
- `RegisterSandboxResult`
- `renderMessage`
- `renderPromptParams`
- `reportFailures`
- `runEvaluator`
- `SandboxConfig`
- `ScorerBuilder`
- `ScorerOpts`
- `ScoreSummary`
- `SerializedBraintrustState`
- `SetCurrentArg`
- `spanComponentsToObjectId`
- `SpanContext`
- `SpanCustomizer`
- `SpanData`
- `SpanDurationFilter`
- `SpanExportData`
- `SpanFetcher`
- `SpanFilters`
- `SpanImpl`
- `summarize`
- `TemplateFormat`
- `templateRegistry`
- `TemplateRenderer`
- `TestBackgroundLogger`
- `ToolBuilder`
- `toolFunctionDefinitionSchema`
- `traceable`
- `TraceContextCarrier`
- `TraceContextHeaders`
- `TRACEPARENT_HEADER`
- `TRACESTATE_HEADER`
- `uploadLogs3OverflowPayload`
- `utf8ByteLength`
- `UUIDGenerator`
- `withDataset`
- `withExperiment`
- `withLogger`
- `WithTransactionId`
- `wrapAISDKModel`
- `wrapMastraAgent`
- `wrapOpenAIv4`
- `X_CACHED_HEADER`

</details>
