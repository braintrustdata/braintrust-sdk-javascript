# @braintrust/temporal

[![npm version](https://img.shields.io/npm/v/%40braintrust%2Ftemporal.svg)](https://www.npmjs.com/package/@braintrust/temporal)

SDK for integrating [Braintrust](https://braintrust.dev) tracing with [Temporal](https://temporal.io/) workflows and activities.

## Installation

This package has peer dependencies that you must install alongside it:

```bash
npm install @braintrust/temporal braintrust @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity @temporalio/common
# or
yarn add @braintrust/temporal braintrust @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity @temporalio/common
# or
pnpm add @braintrust/temporal braintrust @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity @temporalio/common
```

## Requirements

- `braintrust`
- `@temporalio/client`
- `@temporalio/worker`
- `@temporalio/workflow`
- `@temporalio/activity`
- `@temporalio/common`

## Quickstart

Initialize Braintrust, then install the plugin on both the Temporal client and worker.

```typescript
import { Client, Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import * as braintrust from "braintrust";
import { BraintrustTemporalPlugin } from "@braintrust/temporal";

braintrust.initLogger({ projectName: "my-project" });

const plugin = new BraintrustTemporalPlugin();

const client = new Client({
  connection: await Connection.connect(),
  plugins: [plugin],
});

// ESM-safe resolution (recommended for ESM projects):
const workflowsUrl = new URL("./workflows", import.meta.url);
const workflowsPath = workflowsUrl.pathname;
// CommonJS resolution (existing/example usage):
// const workflowsPath = require.resolve("./workflows");
const worker = await Worker.create({
  taskQueue: "my-queue",
  workflowsPath: workflowsPath,
  activities,
  plugins: [plugin],
});
```

## Workflow Interceptors

This package also exports workflow interceptors that are loaded into the Temporal workflow isolate:

- `@braintrust/temporal/workflow-interceptors`

The `BraintrustTemporalPlugin` automatically configures `workflowModules` to include these interceptors when used on a worker.

## Examples

See the examples in `examples/temporal-cjs`, `examples/temporal-esm`, and `examples/temporal-ai-sdk`.

## Documentation

- Braintrust docs: [https://docs.braintrust.dev](https://docs.braintrust.dev)
- Temporal docs: [https://docs.temporal.io/](https://docs.temporal.io/)
