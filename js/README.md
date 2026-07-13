[![Braintrust](https://raw.githubusercontent.com/braintrustdata/braintrust-sdk-javascript/main/braintrust-logo.svg)](https://www.braintrust.dev/)

# Braintrust JavaScript SDK

[![npm version](https://img.shields.io/npm/v/braintrust.svg)](https://www.npmjs.com/package/braintrust)

An isomorphic JavaScript/TypeScript SDK for logging, tracing, and evaluating AI applications with [Braintrust](https://www.braintrust.dev/). For more details, see the [Braintrust docs](https://www.braintrust.dev/docs)

## Installation

Install the SDK:

```bash
npm install braintrust
```

## Quickstart

Run a simple experiment (replace `YOUR_API_KEY` with your Braintrust API key):

```typescript
import * as braintrust from "braintrust";

async function main() {
  const experiment = await braintrust.init("NodeTest", {
    apiKey: "YOUR_API_KEY",
  });

  experiment.log({
    input: { test: 1 },
    output: "foo",
    expected: "bar",
    scores: {
      n: 0.5,
    },
    metadata: {
      id: 1,
    },
  });

  console.log(await experiment.summarize());
}

main().catch(console.error);
```

## Auto-Instrumentation

Braintrust can automatically instrument popular AI SDKs (OpenAI, Anthropic, Vercel AI SDK, and others) to log calls without manual wrapper code.

### Node.js

Use the runtime import hook:

```bash
node --import braintrust/hook.mjs app.js
```

### Bundled Apps

Use a bundler plugin:

Vite:

```ts
import { braintrustVitePlugin } from "braintrust/vite";

export default {
  plugins: [braintrustVitePlugin()],
};
```

Webpack:

```js
const { braintrustWebpackPlugin } = require("braintrust/webpack");

module.exports = {
  plugins: [braintrustWebpackPlugin()],
};
```

esbuild:

```ts
import { braintrustEsbuildPlugin } from "braintrust/esbuild";

await esbuild.build({
  plugins: [braintrustEsbuildPlugin()],
});
```

Rollup:

```ts
import { braintrustRollupPlugin } from "braintrust/rollup";

export default {
  plugins: [braintrustRollupPlugin()],
};
```

If you use TypeScript or other transpilation plugins, place the Braintrust plugin after them so transformed output is instrumented.

For deeper details, see the [auto-instrumentation architecture docs](src/auto-instrumentations/README.md).

### LangSmith tracing

Braintrust supports LangSmith `>=0.3.30 <1.0.0`. LangSmith tracing remains authoritative: LangSmith must be enabled, and it continues exporting traces to LangSmith while Braintrust mirrors the same run lifecycle. This integration covers tracing only; LangSmith eval, Jest, and Vitest APIs are not instrumented.

For automatic Node.js instrumentation, use the standard hook before importing LangSmith:

```bash
node --import braintrust/hook.mjs app.js
```

The Vite, Webpack, esbuild, and Rollup plugins shown above apply the same automatic instrumentation in bundled applications. To instrument explicit namespaces instead, wrap the three LangSmith entrypoints you use:

```typescript
import {
  wrapLangSmithClient,
  wrapLangSmithRunTrees,
  wrapLangSmithTraceable,
} from "braintrust";
import * as clientNamespace from "langsmith/client";
import * as runTreesNamespace from "langsmith/run_trees";
import * as traceableNamespace from "langsmith/traceable";

const { Client } = wrapLangSmithClient(clientNamespace);
const { RunTree } = wrapLangSmithRunTrees(runTreesNamespace);
const { traceable } = wrapLangSmithTraceable(traceableNamespace);
```

The wrappers are composable and idempotent. They preserve LangSmith behavior, including its network export and `on_end` callbacks. Automatic and explicit instrumentation can safely be used together.

Disable LangSmith instrumentation in code or through the environment:

```typescript
import { configureInstrumentation } from "braintrust";

configureInstrumentation({ integrations: { langsmith: false } });
```

```bash
BRAINTRUST_DISABLE_INSTRUMENTATION=langsmith node --import braintrust/hook.mjs app.js
```

When Braintrust LangChain/LangGraph instrumentation is enabled, LangSmith runs serialized by LangChain are ignored to avoid duplicate spans. Set `langchain: false` (and use LangSmith instrumentation) when LangSmith should be the source for those runs instead.

## Migration Guides

### Upgrading from 2.x to 3.x

See the [Migrate from v2.x to v3.x guide](https://www.braintrust.dev/docs/reference/sdks/typescript/migrations/v2-to-v3).

In 3.x, browser usage should move to `@braintrust/browser` instead of relying on the legacy `braintrust/browser` path.

### Upgrading from 1.x to 2.x

See the [Migrate from v1.x to v2.x guide](https://www.braintrust.dev/docs/reference/sdks/typescript/migrations/v1-to-v2).

### Upgrading from 0.x to 1.x

See the [Migrate from v1.x to v2.x guide](https://www.braintrust.dev/docs/reference/sdks/typescript/migrations/v0-to-v1).

## Compatibility

The `braintrust` package is compatible with Node.js versions 20.12.0, 22.13.0, for the respective major Node.js release lines and above.
