---
"braintrust": patch
---

fix(langchain): Record tool and agent action spans with the tool span type

LangChain tool runs and agent actions were previously typed as `llm` spans. They now use the `tool` type, matching the Python SDK.
