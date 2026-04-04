# @braintrust/openai-agents

## 0.1.5

### Patch Changes

- Ensured the root span is flushed during `onTraceEnd()` so traces are marked complete even in short-lived and serverless processes.
- Added test coverage around trace completion and root span flushing behavior.
