---
"braintrust": minor
---

Add dataset versioning support to `init()`, `initDataset()`, and dataset objects.

You can now pin dataset reads and experiment registration by explicit version, snapshot name, or environment tag:

```ts
import { init, initDataset } from "braintrust";

const datasetByVersion = initDataset({
  project: "support-bot",
  dataset: "production-cases",
  version: "1234567890123456",
});

const datasetBySnapshot = initDataset({
  project: "support-bot",
  dataset: "production-cases",
  snapshotName: "baseline",
});

const datasetByEnvironment = initDataset({
  project: "support-bot",
  dataset: "production-cases",
  environment: "production",
});

init({
  project: "support-bot",
  experiment: "baseline-eval",
  dataset: {
    id: "00000000-0000-0000-0000-000000000123",
    snapshotName: "baseline",
  },
});
```

Dataset objects now expose snapshot CRUD helpers, plus lookup by snapshot name or xact id:

```ts
const dataset = initDataset({
  project: "support-bot",
  dataset: "production-cases",
});

const snapshot = await dataset.createSnapshot({
  name: "baseline",
  description: "Before the prompt rollout",
});

await dataset.updateSnapshot(snapshot.id, {
  name: "baseline-v2",
  description: null,
});

const snapshots = await dataset.listSnapshots();
const byName = await dataset.getSnapshot({
  snapshotName: "baseline-v2",
});
const byXactId = await dataset.getSnapshot({
  xactId: snapshot.xact_id,
});

await dataset.deleteSnapshot(snapshot.id);
```

`braintrust/dev` now also respects `dataset_version` and `dataset_environment` when resolving datasets for evals, so local eval runs match the pinned dataset selection used by the main SDK.
