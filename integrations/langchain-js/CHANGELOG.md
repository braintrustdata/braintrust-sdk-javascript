# @braintrust/langchain-js

## 0.2.5

- `@braintrust/langchain-js` is now deprecated. This release marks the last release for this package. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2383)
- Updated dependencies: braintrust@3.29.0

### Migration

To migrate, install `braintrust` and import `BraintrustLangChainCallbackHandler`
from `braintrust` instead. See the
[LangChain integration guide](https://www.braintrust.dev/docs/integrations/sdk-integrations/langchain)
for setup examples. For application-wide instrumentation, use the Braintrust
runtime hook described in the
[auto-instrumentation guide](https://www.braintrust.dev/docs/instrument/trace-llm-calls#auto-instrumentation).
`setGlobalHandler` has no direct replacement; use automatic instrumentation or
pass the callback handler explicitly.

## 0.2.4

### Patch Changes

- feat: Add LangChain and LangGraph auto-instrumentation (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1897)
- Updated dependencies: braintrust@3.12.0

## 0.2.3

### Patch Changes

- Added prompt caching token tracking for LangChain usage metadata.
- Mapped nested `input_token_details` metrics into Braintrust's standard cached-token fields, including cache reads and cache creation tokens.
