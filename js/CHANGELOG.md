# braintrust

## 3.16.0

### Minor Changes

- feat: Export `LocalTrace` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2088)
- feat(invoke): Allow passing `overrides` to `invoke()` Thanks @paultancre-bt! (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2087)

### Patch Changes

- fix: Don't have `output` in dataset pipeline row type definition (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2089)

## 3.15.0

**Attention:** This release is technically a breaking change because it removes the `wrapFlueContext`, and `wrapFlueSession` exports for `@flue/runtime`. This release was still deemed as a minor because of the experimental state of flue and limited adoption of `@flue/runtime` instrumentation.

- feat(flue): Update flue instrumentation to use new observe hooks (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2070)

## 3.14.0

### Minor Changes

- feat(mastra): Add Mastra auto-instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1901)
- feat: Add `BRAINTRUST_CACHE_LOCATION` env var to control caching location (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2061)

## 3.13.0

### Minor Changes

- feat: Upwards-recursively read `.env.braintrust` containing `BRAINTRUST_API_KEY` on login in Node.js (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2049)
- feat: Add Dataset pipelines (experimental) (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1933)
- feat: Include span id in dataset pipeline argument (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2055)

## 3.12.0

### Minor Changes

- feat: Add `@flue/runtime` instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2037)
- feat: Add `braintrust/apply-auto-instrumentation` entrypoint for CJS/TS patching (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2038)
- feat(nextjs): Add `wrapNextjsConfigWithBraintrust` as canonical setup utility instead of webpack loader/plugin (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2033)
- feat(bundler-plugins): Add `braintrustVitePlugin`, `braintrustWebpackPlugin`, `braintrustEsbuildPlugin`, `braintrustRollupPlugin` aliases for bundler plugins and deprecate old ones (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2032)

### Patch Changes

- feat: Add OpenAI Agents SDK auto-instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1891)
- feat: Add LangChain and LangGraph auto-instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1897)
- fix(security): reject `__proto__`, `constructor`, and `prototype` keys in `mergeDicts` / `mergeDictsWithPaths` to prevent prototype pollution from untrusted merge sources (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2026)
- feat: Allow for multi project tracing by removing parent project ID restriction (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2044)
- feat: Do not collect git metadata by default when organization-level git metadata settings are absent (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2045)
- Add exponential backoff between existing `get_json` retry attempts (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1965)

## 3.11.0

### Minor Changes

- feat: Add instrumentation for `@github/copilot-sdk` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1932)
- feat(vitest): Support `projectId` in `wrapVitest` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1993)
- feat: Add Firebase genkit instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1948)
- feat(mistral): Instrument classification and moderation APIs (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1947)
- feat: Add `@openai/codex-sdk` instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1945)

### Patch Changes

- fix(openrouter): Capture reasoning (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1944)
- fix(openai): Prevent reading body more than once (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1969)
- fix(cohere): Wrap v2 subclient (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1943)
- fix: Prevent duplicate LLM spans when multiple SDK instances are loaded in the same process (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1973)
- fix(openrouter): Mark callModel parent spans as tasks and avoid double-counting metrics Thanks @ronaldkohhh! (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2005)
- deps: Upgrade minimatch from v9 to v10. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2000)
- fix(groq): Capture reasoning for groq reasoning models (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1942)
- fix(google-adk): Fix google adk agent naming (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1950)
- fix: Cancel body consumption immediately for object store upload (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2001)
- fix(deps): Upgrade Express to remove vulnerable transitive dependencies (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2002)
- fix(google-genai): Capture multi-turn message APIs with wrapper (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1946)

## 3.10.0

### Minor Changes

- feat: Add dataset versioning support (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1837)
- feat: Add `@cursor/sdk` instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1923)
- feat: Add auto and wrapper instrumentation for `@github/copilot-sdk`
- feat: Add experiment dataset filters to experiment metadata (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1898)

### Patch Changes

- fix(auto-instrumentation): Skip over file transforms in bundler plugins when id is undefined (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1886)
- fix: Fix export map for bundler plugins (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1870)
- feat: Bump google ADK patching range to include new major `1.0.0` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1885)
- feat: Add instrumentation for groq-sdk (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1866)
- fix: Correct the eval file extension shown in CLI directory warnings (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1928)
- feat: Capture thinking with cohere (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1861)
- fix: Capture reasoning in mistral (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1863)
- fix(huggingface): Capture streamed tool calls (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1848)
- fix(claude-agent-sdk): Nest built-in tools under sub-agents (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1881)

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
