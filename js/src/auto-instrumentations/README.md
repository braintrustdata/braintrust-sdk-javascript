# Auto-Instrumentation Internals

This document describes the internal architecture of the Braintrust auto-instrumentation system.

## Architecture Overview

The auto-instrumentation system uses [orchestrion-js](https://github.com/apm-js-collab/orchestrion-js) to perform AST transformations at load-time or build-time, injecting `diagnostics_channel` instrumentation into AI SDK methods.

## How It Works

### 1. Instrumentation Configs

Each SDK integration defines **instrumentation configs** that specify which functions to instrument:

```typescript
{
  channelName: 'chat.completions.create',
  module: {
    name: 'openai',
    versionRange: '>=4.0.0',
    filePath: 'resources/chat/completions.mjs'
  },
  functionQuery: {
    className: 'Completions',
    methodName: 'create',
    kind: 'Async'
  }
}
```

**Note:** The `channelName` should NOT include the `orchestrion:` prefix. The code-transformer automatically prepends `orchestrion:` + `module.name` + `:` to these names.

**Important:** The code-transformer uses the **exact module name** from the config. For example:

- Module `openai` → Channel `orchestrion:openai:chat.completions.create`
- Module `@anthropic-ai/sdk` → Channel `orchestrion:@anthropic-ai/sdk:messages.create`
- Module `@google/genai` → Channel `orchestrion:@google/genai:models.generateContent`

Plugin subscriptions must match these **exact** channel names for instrumentation to work.

### 2. AST Transformation

At build-time or load-time, orchestrion-js transforms the source code by wrapping instrumented functions with `tracingChannel` calls:

**Before:**

```typescript
class Completions {
  async create(params) {
    // ... actual implementation
  }
}
```

**After:**

```typescript
import { tracingChannel } from 'dc-polyfill';

class Completions {
  async create(params) {
    const channel = tracingChannel('orchestrion:openai:chat.completions.create');
    return channel.tracePromise(
      () => /* original implementation */,
      { arguments: [params] }
    );
  }
}
```

### 3. Event Subscription

The `BraintrustPlugin` (in the main `braintrust` package at `js/src/instrumentation/braintrust-plugin.ts`) subscribes to these channels and converts the events into Braintrust spans:

```typescript
channel.subscribe({
  start: (event) => {
    // Create span and store it on the event for access in other handlers
    const span = startSpan({ name: 'Chat Completion', type: 'llm' });
    span.log({ input: event.arguments[0].messages });
    event.span = span;
  },
  asyncStart: (event) => {
    // Called when the async callback/promise is reached
    // Retrieve span from event and log the result
    const span = event.span;
    span.log({ output: event.result.choices, metrics: { tokens: ... } });
    span.end();
  },
  error: (event) => {
    // Retrieve span from event and log the error
    const span = event.span;
    span.log({ error: event.error });
    span.end();
  }
});
```

## Load-Time vs Build-Time Instrumentation

### Load-Time (Node.js Hook)

The `hook.mjs` file uses Node.js's module loader hooks to intercept module loading and apply transformations on-the-fly. This approach:

- Works with both ESM and CJS modules
- Requires no build step
- Adds minimal overhead at startup
- Is the recommended approach for Node.js applications

### Build-Time (Bundler Plugins)

The bundler plugins (Vite, Webpack, esbuild, Rollup) apply transformations during the build process. This approach:

- Required for browser environments (no Node.js hooks available)
- Zero runtime overhead (transformations done at build time)
- Works with bundled Node.js applications

## Plugin Architecture

The plugin system follows the OpenTelemetry pattern:

- **Core Infrastructure**: `js/src/instrumentation/core/` in the main `braintrust` package
  - `BasePlugin` - Abstract base class for plugins
  - Channel utilities (`createChannelName`, `parseChannelName`, etc.)
  - Event type definitions

- **Braintrust Implementation**: `js/src/instrumentation/braintrust-plugin.ts` in the main `braintrust` package
  - `BraintrustPlugin` - Converts diagnostics_channel events into Braintrust spans
  - Automatically enabled when the Braintrust SDK is loaded
  - Supports configuration to disable specific integrations

- **Plugin Registry**: `js/src/instrumentation/registry.ts` in the main `braintrust` package
  - `PluginRegistry` - Manages plugin lifecycle
  - Automatically enables `BraintrustPlugin` on SDK initialization
  - Reads configuration from `configureInstrumentation()` API and `BRAINTRUST_DISABLE_INSTRUMENTATION` environment variable
  - `configureInstrumentation()` - Public API for disabling specific integrations

- **Integration Configs**: `src/configs/` in this package
  - SDK-specific instrumentation configurations
  - Consumed by orchestrion-js for transformation

### Auto-Enable Mechanism

The instrumentation is automatically enabled when the Braintrust SDK is loaded:

1. **Node.js**: When `configureNode()` is called (in `src/node.ts`), it calls `registry.enable()`
2. **Browser**: When `configureBrowser()` is called (in `src/browser-config.ts`), it calls `registry.enable()`
3. The registry creates and enables `BraintrustPlugin` with the appropriate configuration
4. Individual integrations (OpenAI, Anthropic, etc.) can be disabled via:
   - Programmatic API: `configureInstrumentation({ integrations: { openai: false } })`
   - Environment variable: `BRAINTRUST_DISABLE_INSTRUMENTATION=openai,anthropic`

### Configuration Priority

Configuration is merged in the following order (later overrides earlier):

1. Default configuration (all integrations enabled)
2. Programmatic configuration via `configureInstrumentation()`
3. Environment variables

**Important**: `configureInstrumentation()` must be called before the SDK is loaded (before importing any AI SDKs) to take effect. After the registry is enabled, configuration changes will log a warning and be ignored.

## Adding Support for a New SDK

1. **Create a config file** in `src/configs/` (e.g., `anthropic.ts`):

```typescript
import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";

export const anthropicConfigs: InstrumentationConfig[] = [
  {
    channelName: "messages.create",
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.20.0",
      filePath: "resources/messages.mjs",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },
];
```

2. **Export the configs** from `src/index.ts`:

```typescript
export { anthropicConfigs } from "./configs/anthropic";
```

3. **Add channel handlers** in `BraintrustPlugin` (in the main `braintrust` package):

```typescript
// In js/src/instrumentation/braintrust-plugin.ts
protected onEnable() {
  // ... existing OpenAI handlers ...

  // Add Anthropic handler
  const anthropicChannel = tracingChannel('orchestrion:anthropic:messages.create');
  anthropicChannel.subscribe({
    asyncStart: (event) => {
      // Create span and log input
    },
    asyncEnd: (event) => {
      // Log output and end span
    },
    error: (event) => {
      // Log error and end span
    }
  });
}
```

## Environment Support: Node.js vs Browser

### Isomorphic Pattern

The instrumentation system uses an **isomorphic pattern** to work seamlessly across environments:

- **Node.js**: Uses native `node:diagnostics_channel` for optimal performance
- **Browser**: Uses `dc-browser` polyfill for compatibility
- **Plugin Code**: Uses `iso.newTracingChannel()` which abstracts the environment difference

This ensures that:

1. Both plugin subscription code AND transformed SDK code use the same channel implementation
2. Events properly propagate between emitters and subscribers
3. No channel registry mismatches occur

### Node.js Setup

**For runtime applications using the loader hook:**

```bash
node --import @braintrust/auto-instrumentations/hook.mjs app.js
```

The hook automatically uses `node:diagnostics_channel`.

**For bundled applications:**

When using bundler plugins (Vite, Webpack, etc.) in Node.js:

```javascript
// vite.config.js
import { braintrustVitePlugin } from "braintrust/vite";

export default {
  plugins: [braintrustVitePlugin()],
};
```

Braintrust-prefixed bundler plugins use Node.js's native `node:diagnostics_channel` module by default.

### Browser Setup

**For browser/edge builds:**

```javascript
// vite.config.js
import { braintrustVitePlugin } from "braintrust/vite";

export default {
  plugins: [braintrustVitePlugin({ useDiagnosticChannelCompatShim: true })],
};
```

Setting `useDiagnosticChannelCompatShim: true` ensures the code-transformer injects `dc-browser` imports for environments where Node.js's `diagnostics_channel` module is unavailable.
The deprecated plugin exports are still available and preserve the old `browser` option, which defaults to `true` when omitted; the new Braintrust-prefixed option defaults to `false`.

**Important:** The `useDiagnosticChannelCompatShim` option must match your target environment:

- Mismatch (e.g., enabling the compatibility shim but running in Node.js) causes channel registry conflicts
- Plugin code uses the iso pattern and adapts automatically
- Only the transformed SDK code is affected by the compatibility shim option

### Next.js Setup

Wrap your Next.js config with `wrapNextjsConfigWithBraintrust` to let Braintrust choose the
webpack plugin or Turbopack loader based on the active Next.js build:

```javascript
// next.config.mjs
import { wrapNextjsConfigWithBraintrust } from "braintrust/next";

const nextConfig = {};

export default wrapNextjsConfigWithBraintrust(nextConfig);
```

For webpack builds, Braintrust uses Next.js' webpack build context to pass
`browser: true` for client and edge bundles and `browser: false` for Node.js
server bundles. For Turbopack builds, Braintrust inserts webpack loader
rules with runtime conditions so client and edge bundles use `browser: true`
and Node.js server bundles use `browser: false`.

## Advanced: Custom Plugins

Third parties can create custom plugins by extending `BasePlugin`:

```typescript
import { BasePlugin } from "braintrust/instrumentation";
import { tracingChannel } from "dc-polyfill";

class MyCustomPlugin extends BasePlugin {
  protected onEnable() {
    const channel = tracingChannel(
      "orchestrion:openai:chat.completions.create",
    );

    channel.subscribe({
      asyncEnd: (event) => {
        // Custom handling - e.g., log to console, send to external service, etc.
        console.log("OpenAI call completed:", event.result);
      },
    });
  }

  protected onDisable() {
    // Cleanup subscriptions
  }
}
```

Note: Plugins must be constructed and enabled within the core Braintrust library. Due to ESM loading semantics, users cannot manually enable plugins from application code.

## Testing

The test suite covers:

- **Config validation** (`src/configs/*.test.ts`) - Verify config structure
- **AST transformation** (`tests/auto-instrumentations/transformation.test.ts`) - Verify orchestrion-js transforms code correctly
- **Runtime execution** (`tests/auto-instrumentations/runtime-execution.test.ts`) - Verify transformed code executes correctly
- **Integration tests** (`tests/auto-instrumentations/integration.test.ts`) - Verify channel name alignment and event flow
- **Error handling** (`tests/auto-instrumentations/error-handling.test.ts`) - Verify errors propagate correctly
- **Plugin tests** (`src/instrumentation/plugins/*.test.ts`) - Unit tests for each plugin

## Troubleshooting

### No Traces Appearing

If auto-instrumentation isn't creating traces, check the following:

#### 1. Channel Name Alignment

**Problem:** Plugin subscriptions don't match the channel names emitted by code-transformer.

**Symptoms:** SDK calls execute normally but no spans appear in Braintrust.

**Solution:** Verify channel names match exactly:

```javascript
// Config (in src/configs/anthropic.ts)
module: {
  name: "@anthropic-ai/sdk";
}
channelName: "messages.create";

// Results in emitted channel:
("orchestrion:@anthropic-ai/sdk:messages.create"); // Full scoped package name

// Plugin MUST subscribe to the exact same name:
iso.newTracingChannel("orchestrion:@anthropic-ai/sdk:messages.create");
```

**Common mistakes:**

- Using shortened names (e.g., `anthropic` instead of `@anthropic-ai/sdk`)
- Missing the `@` scope prefix
- Wrong package name entirely

Run integration tests to verify alignment:

```bash
pnpm test -- tests/auto-instrumentations/integration.test.ts
```

#### 2. Browser/Node.js Mismatch

**Problem:** Bundler diagnostics channel compatibility setting doesn't match runtime environment.

**Symptoms:**

- "Cannot find module 'node:diagnostics_channel'" errors in browser
- Events not propagating in Node.js

**Solution:**

- For Node.js apps: Use a Braintrust-prefixed bundler plugin with default options
- For browser apps: Set `useDiagnosticChannelCompatShim: true`
- For Node.js runtime apps: Use the loader hook instead of bundling

#### 3. APIPromise Compatibility (Anthropic SDK)

**Problem:** Anthropic's `APIPromise` has incompatible constructor with `Promise`.

**Symptoms:**

- Errors like "APIPromise constructor called with wrong arguments"
- Traces failing specifically with Anthropic SDK

**Solution:** The auto-instrumentation hook automatically patches `APIPromise` to fix this. Ensure you're using the hook:

```bash
node --import @braintrust/auto-instrumentations/hook.mjs app.js
```

Or when using bundlers, the patch is applied automatically when plugins are enabled.

#### 4. Import Order Issues

**Problem:** SDK imported before Braintrust is configured.

**Solution:** Import and configure Braintrust before importing AI SDKs:

```javascript
// CORRECT
import { configureNode } from "braintrust";
configureNode();

import Anthropic from "@anthropic-ai/sdk"; // Now instrumented

// INCORRECT
import Anthropic from "@anthropic-ai/sdk"; // Not instrumented yet

import { configureNode } from "braintrust";
configureNode(); // Too late!
```

### Debugging Channel Events

To debug channel event flow, enable debug logging:

```bash
DEBUG=braintrust:* node --import @braintrust/auto-instrumentations/hook.mjs app.js
```

Or add manual logging in your code:

```javascript
import iso from "braintrust/isomorph";

const channel = iso.newTracingChannel(
  "orchestrion:@anthropic-ai/sdk:messages.create",
);

channel.subscribe({
  start: (event) => {
    console.log("Channel event received:", event);
  },
});
```

### Known Issues

#### TypeScript Errors with Bundler Plugins

If TypeScript has resolution issues with direct internal imports, use the public Braintrust bundler entrypoints:

```javascript
import { braintrustVitePlugin } from "braintrust/vite";
```

#### ESM vs CJS Mixing

The loader hook works best with pure ESM projects. For CJS projects:

- Use the bundler plugin approach
- Or ensure all instrumented SDKs are ESM

## Migration Guide

### From dc-browser to Isomorphic Pattern

If you have custom plugins that import `dc-browser` directly:

**Before:**

```javascript
import { tracingChannel } from "dc-browser";

const channel = tracingChannel("my-channel");
```

**After:**

```javascript
import iso from "braintrust/isomorph";

const channel = iso.newTracingChannel("my-channel");
```

This ensures your plugin works in both Node.js (using `node:diagnostics_channel`) and browser (using `dc-browser`) environments.

### Channel Name Updates

If you created custom instrumentations before the channel name fixes:

**Before:**

```javascript
// Plugin incorrectly used shortened names
channel.subscribe("orchestrion:anthropic:messages.create");

// Config used full name
module: {
  name: "@anthropic-ai/sdk";
}
// ❌ Mismatch - events won't be received!
```

**After:**

```javascript
// Plugin uses EXACT module name from config
channel.subscribe("orchestrion:@anthropic-ai/sdk:messages.create");

// Config uses full name
module: {
  name: "@anthropic-ai/sdk";
}
// ✅ Match - events will be received
```
