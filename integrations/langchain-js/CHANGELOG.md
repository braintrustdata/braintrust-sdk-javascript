# @braintrust/langchain-js

## 0.2.5

### Patch Changes

- ref: Deprecate `@braintrust/openai-agents`, `@braintrust/langchain-js`, and `@braintrust/vercel-ai-sdk` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2383)
- Updated dependencies: braintrust@3.29.0

## 0.2.4

### Patch Changes

- feat: Add LangChain and LangGraph auto-instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1897)
- Updated dependencies: braintrust@3.12.0

## 0.2.3

### Patch Changes

- Added prompt caching token tracking for LangChain usage metadata.
- Mapped nested `input_token_details` metrics into Braintrust's standard cached-token fields, including cache reads and cache creation tokens.
