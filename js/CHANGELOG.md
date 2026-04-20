# braintrust

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
