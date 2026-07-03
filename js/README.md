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

## Migration Guides

### Upgrading from 2.x to 3.x

See the [Migrate from v2.x to v3.x guide](https://www.braintrust.dev/docs/reference/sdks/typescript/migrations/v2-to-v3).

In 3.x, browser usage should move to `@braintrust/browser` instead of relying on the legacy `braintrust/browser` path.

### Upgrading from 1.x to 2.x

See the [Migrate from v1.x to v2.x guide](https://www.braintrust.dev/docs/reference/sdks/typescript/migrations/v1-to-v2).

### Upgrading from 0.x to 1.x

See the [Migrate from v1.x to v2.x guide](https://www.braintrust.dev/docs/reference/sdks/typescript/migrations/v0-to-v1).
