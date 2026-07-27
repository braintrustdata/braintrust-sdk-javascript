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

`DurableEval` is an additive evaluation API for work that must survive process
restarts or run through asynchronous provider batch jobs. It checkpoints cases,
task outputs, scores, provider job handles, and attempts outside Braintrust,
while completed results are incrementally merged into a normal Braintrust
experiment.

Every case needs a stable `id` (or a `caseId` function). Reusing a `runId`
resumes the same input snapshot and never reruns successful work.

```typescript
import { BatchTask, DurableEval, FileDurableEvalStore } from "braintrust";

const store = new FileDurableEvalStore();
const supportEval = DurableEval("Support bot", {
  revision: process.env.GIT_SHA ?? "local",
  data: [
    {
      id: "password-reset",
      input: "How do I reset my password?",
      expected: "Open account settings...",
    },
  ],
  task: BatchTask({
    revision: "generation-v1",

    // Each provider job contains at most 500 eval cases. Up to four jobs may
    // be in flight for this task stage at once.
    batchSize: 500,
    maxConcurrentBatches: 4,

    // Upload/submit an asynchronous provider batch and return a
    // JSON-serializable handle.
    async submit(items, context) {
      const batch = await provider.submit({
        idempotencyKey: context.batchId,
        metadata: { durableBatchId: context.batchId },
        items,
      });
      return { id: batch.id };
    },

    completion: {
      mode: "webhook",
      source: "provider",
      externalId: (handle) => handle.id,
    },

    async *collect(handle) {
      for await (const item of provider.results(handle.id)) {
        yield {
          id: item.id,
          output: item.output,
        };
      }
    },
  }),
  scores: [
    function exact({ output, expected }) {
      return output === expected ? 1 : 0;
    },
  ],
});

const result = await supportEval.run({
  runId: "release-2026-07-27",
  store,
  deadlineMs: 30 * 60 * 1000,
});

if (result.status === "paused") {
  await result.resume({ deadlineMs: 30 * 60 * 1000 });
}
```

Use `BatchScorer` for asynchronous batch scoring. Existing per-item tasks and
scorers are also supported and gain checkpointing and retries. The filesystem
store is intended for one machine; distributed workers should share a
compare-and-set-capable `DurableEvalStore`. Launch fixed shards through the API
or the existing CLI:

```bash
npx braintrust eval evaluation.eval.ts \
  --run-id release-2026-07-27 \
  --shard 0/8 \
  --deadline 6h
```

An ordinary error thrown from `submit` is considered ambiguous, because the
provider may have created a job before the connection failed. The run pauses
instead of risking duplicate charges. Throw `DurableEvalNotSubmittedError` only
when it is known that no provider job was created, or implement `recover` to
look up a prior submission using `context.batchId`.

The `submit`/`completion`/`collect` split is designed for provider-managed batch
APIs, including OpenAI's Batch API. A polling adapter uses
`completion: { mode: "poll", poll }`. A webhook adapter returns while the job is
pending and resumes through `processBatchResult`. `collect` then fetches and
stores the item results before the eval advances to scoring. Every provider
result must carry the durable item `id`. Batch tasks and batch scorers use the
same contract.

### Webhook processing

Verify the provider signature against the raw request body before calling the
durable eval definition. The HTTP framework and provider SDK remain outside the
generic durable API:

```typescript
app.post("/webhooks/provider", rawBodyMiddleware, async (request, response) => {
  const event = provider.verifyWebhook(request.rawBody, request.headers);
  const batch = await provider.getBatch(event.batchId);

  const result = await supportEval.processBatchResult(
    {
      eventId: event.id,
      source: "provider",
      externalId: batch.id,
      batchId: batch.metadata?.durableBatchId,
      handle: { id: batch.id },
      outcome:
        batch.status === "completed"
          ? { status: "complete" }
          : {
              status: "failed",
              error: { status: batch.status },
              retryable: false,
            },
      // Optional JSON payloads are checkpointed with the deduplicated event.
      payload: { type: event.type },
    },
    {
      // Web workers and eval workers must use the same durable store.
      store,
    },
  );

  response.status(result.status === "pending" ? 202 : 200).end();
});
```

`eventId` makes delivery idempotent. The SDK indexes a job by its internal
`batchId` before calling `submit`, then adds the provider `externalId` after the
handle is known. An early event is stored in an inbox and attached when that
second index appears. If a worker dies after the provider accepted a batch but
before its handle was checkpointed, include both the internal `batchId` and a
JSON-serializable `handle` in the event to resolve the ambiguous submission.
Without a handle or a successful `recover` callback, the run pauses safely.

Pure webhook stages return
`{ status: "paused", reason: "waiting_for_webhook" }` instead of holding a
process open. A webhook completion may also define `pollFallback` with
`afterMs`, `poll`, and an optional `intervalMs`.

All orchestration state lives in the configured `DurableEvalStore`; this API
does not require a Braintrust backend change.

The definition object exposes `run`, `status`, `retryFailed`,
`resubmitUnknown`, `cancel`, and `processBatchResult`. The corresponding
lifecycle operations are also available through the CLI:

```bash
npx braintrust eval evaluation.eval.ts --run-id release-2026-07-27 --status
npx braintrust eval evaluation.eval.ts --run-id release-2026-07-27 --retry-failed
npx braintrust eval evaluation.eval.ts --run-id release-2026-07-27 --resubmit-unknown
npx braintrust eval evaluation.eval.ts --run-id release-2026-07-27 --cancel
```

`--resubmit-unknown` is intentionally explicit because the original provider
job may exist and resubmitting it can duplicate work and cost.

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
