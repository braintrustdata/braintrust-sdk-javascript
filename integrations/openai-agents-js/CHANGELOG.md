# @braintrust/openai-agents

## 0.1.6

- `@braintrust/openai-agents` is now deprecated. This release marks the last release for this package. (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2383)
- Updated dependencies: braintrust@3.29.0

### Migration

To migrate, install `braintrust` and import `OpenAIAgentsTraceProcessor` from
`braintrust/instrumentation` instead. See the
[OpenAI Agents SDK integration guide](https://www.braintrust.dev/docs/integrations/agent-frameworks/openai-agents-sdk)
for setup examples.

## 0.1.5

### Patch Changes

- Ensured the root span is flushed during `onTraceEnd()` so traces are marked complete even in short-lived and serverless processes.
- Added test coverage around trace completion and root span flushing behavior.
