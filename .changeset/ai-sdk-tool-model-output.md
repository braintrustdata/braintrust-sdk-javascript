---
"braintrust": patch
---

fix(ai-sdk): Log toModelOutput results for tools that define it

When an AI SDK tool defines `toModelOutput`, its tool span and the parent span's tool results now log the value the model saw instead of the raw `execute` result.
