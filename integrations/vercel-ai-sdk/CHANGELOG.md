# @braintrust/vercel-ai-sdk

## 0.0.7

### Patch Changes

- ref: Deprecate `@braintrust/openai-agents`, `@braintrust/langchain-js`, and `@braintrust/vercel-ai-sdk` (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2383)
- Updated dependencies: braintrust@3.29.0

## 0.0.6

### Patch Changes

- Update the AI SDK dependency to a patched version and preserve stream adapter compatibility. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1992)
- Updated dependencies: braintrust@3.11.0

## 0.0.5

### Patch Changes

- Added `toDataStreamResponse()` as the preferred response helper for Braintrust streams.
- Kept `toAIStreamResponse()` as a deprecated alias for compatibility.
- Updated the adapter for compatibility with newer Zod versions.
