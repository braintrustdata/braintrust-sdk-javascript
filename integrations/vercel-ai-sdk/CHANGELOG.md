# @braintrust/vercel-ai-sdk

## 0.0.7

- `@braintrust/vercel-ai-sdk` is now deprecated. This release marks the last release for this package. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2383)
- Updated dependencies: braintrust@3.29.0

### Migration

To migrate manual instrumentation, install `braintrust` and use `wrapAISDK`
from `braintrust` as described in the
[Vercel AI SDK integration guide](https://www.braintrust.dev/docs/integrations/sdk-integrations/vercel).
Automatic AI SDK instrumentation is also available through the Braintrust
runtime hook and supported bundler integrations; see the
[auto-instrumentation guide](https://www.braintrust.dev/docs/instrument/trace-llm-calls#auto-instrumentation)
for setup instructions. The legacy `BraintrustAdapter` stream conversion
helpers have no direct replacement; migrate those usages to `BraintrustStream`
from `braintrust`, documented in the
[TypeScript SDK reference](https://www.braintrust.dev/docs/reference/libs/nodejs),
and the current AI SDK stream response APIs.

## 0.0.6

### Patch Changes

- Update the AI SDK dependency to a patched version and preserve stream adapter compatibility. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/1992)
- Updated dependencies: braintrust@3.11.0

## 0.0.5

### Patch Changes

- Added `toDataStreamResponse()` as the preferred response helper for Braintrust streams.
- Kept `toAIStreamResponse()` as a deprecated alias for compatibility.
- Updated the adapter for compatibility with newer Zod versions.
