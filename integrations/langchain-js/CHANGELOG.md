# @braintrust/langchain-js

## 0.2.4

### Patch Changes

- feat: Add LangChain and LangGraph auto-instrumentation. The `@braintrust/langchain-js` `BraintrustCallbackHandler` now delegates to the shared implementation in `braintrust`, removing duplicated span/metric extraction logic. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1897)
- Updated dependencies: braintrust@3.12.0

## 0.2.3

### Patch Changes

- Added prompt caching token tracking for LangChain usage metadata.
- Mapped nested `input_token_details` metrics into Braintrust's standard cached-token fields, including cache reads and cache creation tokens.
