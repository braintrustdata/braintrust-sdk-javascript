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

## Durable evaluations

`DurableEval` runs tasks and scorers through asynchronous provider batch APIs.
`batchSize` splits a dataset into provider-sized sub-batches. A small external
store connects submitted jobs with later webhook callbacks; it is required on
the eval definition so every invocation uses the same persistence authority.
No Braintrust backend changes are required.

Every case needs a stable `id` (or a `caseId` function).

```typescript
import { BatchTask, DurableEval, type DurableEvalStore } from "braintrust";

const store: DurableEvalStore = checkpointStore;
const supportEval = DurableEval("Support bot", {
  store,
  data: [
    {
      id: "password-reset",
      input: "How do I reset my password?",
      expected: "Open account settings...",
    },
  ],
  task: BatchTask({
    // Each provider job contains at most 500 eval cases.
    batchSize: 500,

    // Submit one sub-batch and return a JSON-serializable provider handle.
    async submit(items, context) {
      const batch = await provider.submit({
        idempotencyKey: context.batchId,
        metadata: { durableBatchId: context.batchId },
        items,
      });
      return { id: batch.id };
    },

    completion: {
      // "webhook" waits for processBatchResult(). Use "poll" with a poll()
      // callback when the provider does not send completion events.
      mode: "webhook",
      externalId: (handle) => handle.id,
    },

    async collect(handle) {
      return (await provider.results(handle.id)).map((item) => ({
        id: item.id,
        output: item.output,
      }));
    },
  }),
  scores: [
    function exact({ output, expected }) {
      return output === expected ? 1 : 0;
    },
  ],
});

const result = await supportEval.start({
  runId: "release-2026-07-27",
});
```

`start()` initializes the run, submits every ready task sub-batch, and returns.
It never waits in a polling loop. When all task results are available, scoring
begins. `BatchScorer` uses the same `batchSize`, `submit`, `completion`, and
array-returning `collect` contract.

### Polling

Polling adapters report the provider's current status through `completion`:

```typescript
completion: {
  mode: "poll",
  async poll(handle) {
    const batch = await provider.getBatch(handle.id);
    if (batch.status === "completed") return { status: "complete" };
    if (batch.status === "failed") {
      return { status: "failed", error: batch.error };
    }
    return { status: "pending" };
  },
},
```

Call `poll()` from a cron, queue worker, or another short-lived invocation. It
checks every previously submitted polling batch once, collects completed
results, submits newly ready work, and returns without sleeping:

```typescript
const result = await supportEval.poll({
  runId: "release-2026-07-27",
});

if (result.status === "waiting" && result.pending.poll > 0) {
  scheduleAnotherPoll();
}
```

`start()`, `poll()`, and `processBatchResult()` return the current eval status.
A waiting result includes the number of submitted batches using each completion
mode:

```typescript
{
  status: "waiting",
  runId: "release-2026-07-27",
  pending: { poll: 2, webhook: 1 },
}
```

Use `status()` to read the same information without polling providers,
collecting results, or advancing the workflow:

```typescript
const status = await supportEval.status({
  runId: "release-2026-07-27",
});
```

Completed statuses have zero pending batches and include the saved experiment
summary. They can be read repeatedly without logging the eval again.

### Multi-stage workflows

The direct `BatchTask({ submit, completion, collect })` form remains the
one-batch shorthand. Use `workflow` when a task or scorer requires multiple
provider batch operations:

```typescript
task: BatchTask({
  workflow(workflow) {
    const draft = workflow.batch("draft", {
      input: ({ input }) => ({ prompt: input }),
      batchSize: 500,
      submit: submitDraftBatch,
      completion: draftCompletion,
      collect: collectDraftBatch,
    });

    return workflow.batch("revise", {
      needs: { draft },
      input: ({ input }, { draft }) => ({ original: input, draft }),
      batchSize: 500,
      submit: submitRevisionBatch,
      completion: revisionCompletion,
      collect: collectRevisionBatch,
    });
  },
}),
```

Every named batch is a persisted workflow node. `needs` can express sequential
operations, parallel branches, and joins. The returned node supplies the final
task output or scorer result.

### Webhook processing

When the provider reports that any task or scorer batch completed, fetch and
store its results through `processBatchResult()`:

```typescript
app.post("/webhooks/provider", async (request, response) => {
  const event = request.body;
  const batch = await provider.getBatch(event.batchId);

  const result = await supportEval.processBatchResult({
    // The provider's batch ID. DurableEval saved it from submit()'s handle.
    externalId: batch.id,
    // The SDK-generated ID passed to submit(); include it in provider metadata
    // when the webhook cannot provide the external ID used by the handle.
    batchId: batch.metadata?.durableBatchId,
  });

  response.status(result.status === "waiting" ? 202 : 200).end();
});
```

The method accepts either `externalId` or `batchId`. The stored batch locator
identifies the task or scorer workflow node, whose `collect()` results are
stored before the eval advances. Webhook idempotency and provider failure
handling remain application responsibilities for now.

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
