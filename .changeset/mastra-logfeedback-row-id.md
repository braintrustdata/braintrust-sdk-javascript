---
"braintrust": patch
---

fix(mastra): Use the Mastra span id as the Braintrust row id so `logFeedback` attaches to the right row instead of landing as a stray. Matches the upstream `@mastra/braintrust` fix (mastra-ai/mastra#11927).
