---
"braintrust": patch
---

fix(openai): align Decisions spans with Python SDK

OpenAI Decisions spans now use the `decision` span type, `question_{index}` IDs for unnamed or repeated questions, `boolean:`-prefixed keys for boolean choices that collide with string choices, and `{label, description}` score criteria, matching the Python SDK and the Braintrust gateway.
