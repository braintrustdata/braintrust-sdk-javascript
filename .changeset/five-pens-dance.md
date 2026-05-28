---
"braintrust": minor
---

feat(mastra): auto-instrument Mastra via its native `ObservabilityExporter`

Replaces the chunk-AST instrumentation with a Braintrust `ObservabilityExporter` that the loader auto-installs into every `new Mastra(...)`. Survives Mastra's content-hashed chunk renames release-to-release because the loader only touches the stable `dist/mastra/index.{js,cjs}` entry point.

Two integration paths:

- **Auto** (default with `node --import braintrust/hook.mjs`): no user code change, the loader wraps `Mastra` to call `defaultInstance.registerExporter(...)` after construction. Requires the user to enable observability via `new Mastra({ observability: new Observability({ ... }) })`.
- **Manual**: `import { BraintrustObservabilityExporter } from "braintrust";` and pass it via `new Mastra({ observability: new Observability({ configs: { default: { exporters: [new BraintrustObservabilityExporter()] } } }) })`.

Requires `@mastra/core >= 1.20.0` for the auto path (the version that added `Mastra.prototype.registerExporter`); older versions silently no-op. Manual integration works on any Mastra version that accepts an `ObservabilityExporter`.
