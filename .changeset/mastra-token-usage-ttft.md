---
"braintrust": patch
---

fix(mastra): Record `time_to_first_token` for streaming Mastra model spans

The Mastra observability exporter now derives `time_to_first_token` (in
seconds) from a streaming model span's `completionStartTime` attribute and its
start time, matching the metric Braintrust surfaces for other streaming LLM
calls.

Ports the TTFT portion of mastra-ai/mastra#11029.
