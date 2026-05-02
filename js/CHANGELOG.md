# braintrust

## 3.10.0

### Minor Changes

- feat: Add auto and wrapper instrumentation for `@github/copilot-sdk`
- Add dataset versioning support to `init()`, `initDataset()`, and dataset objects. You can now pin dataset reads and experiment registration by explicit version, snapshot name, or environment tag: `ts import { init, initDataset } from "braintrust"; const datasetByVersion = initDataset({ project: "support-bot", dataset: "production-cases", version: "1234567890123456", }); const datasetBySnapshot = initDataset({ project: "support-bot", dataset: "production-cases", snapshotName: "baseline", }); const datasetByEnvironment = initDataset({ project: "support-bot", dataset: "production-cases", environment: "production", }); init({ project: "support-bot", experiment: "baseline-eval", dataset: { id: "00000000-0000-0000-0000-000000000123", snapshotName: "baseline", }, }); ` Dataset objects now expose snapshot CRUD helpers, plus lookup by snapshot name or xact id: `ts const dataset = initDataset({ project: "support-bot", dataset: "production-cases", }); const snapshot = await dataset.createSnapshot({ name: "baseline", description: "Before the prompt rollout", }); await dataset.updateSnapshot(snapshot.id, { name: "baseline-v2", description: null, }); const snapshots = await dataset.listSnapshots(); const byName = await dataset.getSnapshot({ snapshotName: "baseline-v2", }); const byXactId = await dataset.getSnapshot({ xactId: snapshot.xact_id, }); await dataset.deleteSnapshot(snapshot.id); ` `braintrust/dev` now also respects `dataset_version` and `dataset_environment` when resolving datasets for evals, so local eval runs match the pinned dataset selection used by the main SDK.
- (feat) Add experiment dataset filters to experiment metadata

### Patch Changes

- fix(auto-instrumentation): Skip over file transforms in bundler plugins when id is undefined
- fix: Fix export map for bundler plugins
- feat: Bump google ADK patching range to include new major `1.0.0`
- feat: Add instrumentation for groq-sdk
- fix: Correct the eval file extension shown in CLI directory warnings
- feat: Capture thinking with cohere
- fix: Capture reasoning in mistral
- fix(huggingface): Capture streamed tool calls
- fix(claude-agent-sdk): Nest built-in tools under sub-agents

## 3.9.0

### Notable Changes

- feat: Add instrumentation for `@huggingface/inference` ([#1807](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1807))
- feat: Add `cohere-ai` instrumentation ([#1781](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1781))
- feat: Add reranking instrumentation for AI SDK and Openrouter SDK [#1824](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1824)
- feat: Instrument Google GenAI `embedContent` for text ([#1821](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1821))
- feat: Instrument Anthropic SDK tool runner ([1833](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1833))

### Other Changes

- feat: Capture grounding metadata for Google GenAI ([#1773](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1773))
- feat: Track server tool use metrics for anthropic SDK ([#1772](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1772))
- feat: Add per-input `trialCount` support to `Eval()` ([#1814](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1814))
- feat(claude-agent-sdk): Improve task lifecycle and lifecycle details ([#1777](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1777))
- feat: Add `x-bt-use-gateway` header to allowed CORS headers ([#1836](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1836))
- perf: Remove `zod` from `deepCopyEvent` ([#1796](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1796))
- fix(auto-instrumentation): Use sync channel for AI SDK CJS `streamText`/`streamObject` in v4+ ([#1768](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1768))
- fix: Give AI SDK top-level api spans type function ([#1769](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1769))
- fix(openai): Collect `logprob` and `refulsals` output for streaming APIs ([#1774](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1774))
- fix(claude-agent-sdk): Don't drop tool spans for spawning subagents ([#1779](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1779))
- fix: Capture anthropic server tool use inputs for streaming APIs ([#1776](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1776))
- fix(ai-sdk): Restore prompt cache metrics ([#1825](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1825))
- fix(openai-agents): End child spans on trace end ([#1813](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1813))
- chore(auto-instrumentation): Upgrade `@apm-js-collab/code-transformer` to v0.12.0 ([#1708](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1708))

## 3.7.1

### Patch Changes

- Preserved all streaming content block types.
- Fixed `wrapOpenAI` so it no longer breaks native private fields on the wrapped client.
- Propagated `templateFormat` in `ScorerBuilder.create()`.
- Rehydrated remote prompt parameters correctly.
- Switched the AI SDK, OpenRouter, Anthropic, Claude Agent SDK, and Google Gen AI wrappers to diagnostics channels.
