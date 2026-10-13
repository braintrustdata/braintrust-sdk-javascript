---
"braintrust": patch
---

fix: fail closed on span customizer errors without dropping records

Preserve original identity, routing, and duration timestamps with `context.customizer_error: true`; strip all other content and prevent attachment uploads. Log safely at most once across SDK bundles, reuse stripped records on retries, and isolate them from merging and masking in ordered export requests.
