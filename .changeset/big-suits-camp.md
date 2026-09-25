---
"braintrust": patch
---

fix: preserve reasoning content in streamed chat traces

Preserve `reasoning_content` returned by OpenAI-compatible chat completion
streams in the recorded message, accumulating fragments separately for each
choice. Preserve empty strings and null-only values without overwriting text
with later null deltas. Other reasoning formats are unchanged.
