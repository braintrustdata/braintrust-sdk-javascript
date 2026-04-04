# braintrust

## 3.7.1

### Patch Changes

- Preserved all streaming content block types.
- Fixed `wrapOpenAI` so it no longer breaks native private fields on the wrapped client.
- Propagated `templateFormat` in `ScorerBuilder.create()`.
- Rehydrated remote prompt parameters correctly.
- Switched the AI SDK, OpenRouter, Anthropic, Claude Agent SDK, and Google Gen AI wrappers to diagnostics channels.
