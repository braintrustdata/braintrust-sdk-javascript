# braintrust

## 3.9.0

### Minor Changes

- [#1824](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1824) [`c980e07`](https://github.com/braintrustdata/braintrust-sdk-javascript/commit/c980e071332e1a81e731db6aac1dbff85db9447e) Thanks [@lforst](https://github.com/lforst)! - feat: Add reranking instrumentation for AI SDK and Openrouter SDK

- [#1738](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1738) [`25d25d5`](https://github.com/braintrustdata/braintrust-sdk-javascript/commit/25d25d5220587c45571f04dfc6e19d4a5a9dd19b) Thanks [@AbhiPrasad](https://github.com/AbhiPrasad)! - - feat: Add instrumentation for @huggingface/inference ([#1807](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1807))
  - feat: Add cohere-ai instrumentation ([#1781](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1781))
  - fix: Capture anthropic server tool use inputs for streaming APIs ([#1776](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1776))
  - feat: Capture grounding metadata for Google GenAI ([#1773](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1773))
  - fix(claude-agent-sdk): Don't drop tool spans for spawning subagents ([#1779](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1779))
  - feat: Track server tool use metrics for anthropic SDK ([#1772](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1772))
  - fix(openai): Collect logprob and refulsals output for streaming APIs ([#1774](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1774))
  - perf: Remove zod from deepCopyEvent ([#1796](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1796))
  - fix(test): Double timeout for slow OpenAI API tests ([#1794](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1794))
  - feat(claude-agent-sdk): Improve task lifecycle and lifecycle details ([#1777](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1777))
  - ci(deps): bump actions/github-script from 8.0.0 to 9.0.0 ([#1783](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1783))
  - ci(deps): bump docker/setup-buildx-action from 3.12.0 to 4.0.0 ([#1782](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1782))
  - chore: Don't use environment (ie. github deployments) for canary tests ([#1775](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1775))
  - chore: Make dependabot less annoying ([#1778](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1778))
  - fix(auto-instrumentation): Upgrade @apm-js-collab/code-transformer to v0.12.0 ([#1708](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1708))
  - fix(auto-instrumentation): Use sync channel for AI SDK CJS streamText/streamObject in v4+ ([#1768](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1768))
  - fix: Give AI SDK top-level api spans type function ([#1769](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1769))

- [#1814](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1814) [`d9b9923`](https://github.com/braintrustdata/braintrust-sdk-javascript/commit/d9b992319874e8a7385693c2be07ca10e9c93c79) Thanks [@lforst](https://github.com/lforst)! - - feat: Add per-input trialCount support to Eval()

- [#1821](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1821) [`1b5de11`](https://github.com/braintrustdata/braintrust-sdk-javascript/commit/1b5de110355100c10da2096e41950f2a8fd83758) Thanks [@lforst](https://github.com/lforst)! - feat: Instrument Google GenAI embedContent for text

### Patch Changes

- [#1825](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1825) [`f389036`](https://github.com/braintrustdata/braintrust-sdk-javascript/commit/f389036634620d85ed391104301f2ea9750a449c) Thanks [@lforst](https://github.com/lforst)! - fix(ai-sdk): Restore prompt cache metrics

- [#1813](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1813) [`2434a0e`](https://github.com/braintrustdata/braintrust-sdk-javascript/commit/2434a0e69806b255b5017b95d82ba83136706d54) Thanks [@lforst](https://github.com/lforst)! - fix(openai-agents): End child spans on trace end

- [#1836](https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1836) [`5581357`](https://github.com/braintrustdata/braintrust-sdk-javascript/commit/5581357d78289267a48a631bfbc24f3501a440a3) Thanks [@stretpjc](https://github.com/stretpjc)! - feat: Add x-bt-use-gateway header to allowed CORS headers

## 3.7.1

### Patch Changes

- Preserved all streaming content block types.
- Fixed `wrapOpenAI` so it no longer breaks native private fields on the wrapped client.
- Propagated `templateFormat` in `ScorerBuilder.create()`.
- Rehydrated remote prompt parameters correctly.
- Switched the AI SDK, OpenRouter, Anthropic, Claude Agent SDK, and Google Gen AI wrappers to diagnostics channels.
