---
"braintrust": patch
---

fix(mastra): Transform LLM input/output for the Braintrust Thread view

The model-generation spans from the Mastra observability exporter
(`model_generation`, `model_step`, `model_chunk`) now log input as a bare
chat-message array (unwrapping Mastra's `{ messages: [...] }` container, or
wrapping a single `{ role, content }` object) and output as an
`{ role: 'assistant', content }` message (unwrapping Mastra's `{ text, ... }`),
so Braintrust's Thread view renders the conversation correctly. All three map to
the `llm` span type and are surfaced together in Thread view, so they share the
transform; the app's dedup coalesces them into one turn. Embedding (`rag_embedding`)
and non-model spans are unchanged.

Ports mastra-ai/mastra#10794 (fixes #9848).
