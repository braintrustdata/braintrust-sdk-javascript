# braintrust

## 3.21.0

### Minor Changes

- feat: Add `inject`/`extract` APIs for distributed tracing across service boundaries (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2141)
- fix(ai-sdk): Don't capture message history in tool spans (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2179)
- feat: Expose flag for toggling realtime mode in span fetcher (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2187)
- feat: Add scorer that exposes helpers to evaluate agents (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2146)
- feat(evals): Forward/pick up `bt eval <...> --sample N` flag (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2165)
- feat(ai-sdk): Add Workflow Agent instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2177)

### Patch Changes

- fix: Synthesize AI SDK total token metrics from prompt and completion counts (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2174)
- fix(ai-sdk): Close `braintrustAISDKTelemetry()` parent spans with AI SDK 7 `onEnd` callbacks (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2172)
- fix(ai-sdk): Keep `wrapAISDK` model child spans correctly parented for concurrent calls sharing a model instance (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2194)
- fix: Fix function invocations by stripping `/v1/proxy` from functions endpoint (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2180)
- ref: Fork `orchestrion-js`, `import-in-the-middle` and `require-in-the-middle` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2154)
- chore: Update platform types (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2196)
- fix: Properly anchor preview domain CORS regex (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2162)

## 3.20.0

### Minor Changes

- feat: Make flue manual instrumentation slightly cleaner with `braintrustFlueInstrumentation()` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2159)

## 3.19.0

### Minor Changes

- feat: Add reporter for `vitest-evals` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2142)
- feat: Add support for `@anthropic-ai/bedrock-sdk` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2143)
- feat: Add support for `@aws-sdk/client-bedrock-runtime` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2145)
- feat: Add support for `@strands-agents/sdk` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2144)
- feat(flue): Remove `AsyncLocalStorage.enterWith()` usage from flue and add support for manual instrumentation for flue v1 (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2152)

### Patch Changes

- fix: Fix dataset row origin for evals and playgrounds (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2140)
- fix(anthropic): Log Anthropic system message first in span input Thanks @joshua-tj! (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2109)

## 3.18.0

### Minor Changes

- feat(ai-sdk): Add AI SDK v7 support (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2121)
- feat: Add `@earendil-works/pi-coding-agent` instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2118)
- feat(google-genai): Add instrumentation for interactions API (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2122)
- deps: Update `bt` to v0.12.0 (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2111)
- feat: Allow inline eval cases to carry explicit origin metadata (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2104)
- feat: Add project-level classifier builder support for function push (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2095)

### Patch Changes

- fix(claude-agent-sdk): Fix subagents span nesting and input (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2119)
- fix: Fix TTFT in AI SDK v6 (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2120)
- fix(flue): Fix span nesting (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2098)
- fix: Validate inline row origin for evals (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2136)
- fix: Fix eval summaries to compare against the experiment’s explicit base experiment ID (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2124)

## 3.17.0

### Minor Changes

- feat: ship the `bt` CLI with the SDK. Installing `braintrust` now exposes a `bt` command in `node_modules/.bin` that runs the prebuilt native binary for your platform (delivered via `@braintrust/bt-*` optional dependencies). If optional dependencies are skipped (e.g. `--no-optional` / `--omit=optional`), a postinstall script downloads the matching binary from the npm registry as a fallback. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2067)

## 3.16.0

### Minor Changes

- feat: Export `LocalTrace` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2088)
- feat(invoke): Allow passing `overrides` to `invoke()` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2087)

### Patch Changes

- fix(stream): Preserve multi-byte UTF-8 split across chunk boundaries (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2091)
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
