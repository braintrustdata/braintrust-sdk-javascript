# @braintrust/openai-agents

## 0.1.6

### Patch Changes

- ref: Deprecate `@braintrust/openai-agents`, `@braintrust/langchain-js`, and `@braintrust/vercel-ai-sdk` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2383)
- Updated dependencies: braintrust@3.29.0

## 0.1.5

### Patch Changes

- Ensured the root span is flushed during `onTraceEnd()` so traces are marked complete even in short-lived and serverless processes.
- Added test coverage around trace completion and root span flushing behavior.
