---
"braintrust": patch
---

fix(mastra): Emit Mastra tags as first-class Braintrust tags

Root-span tags from the Mastra observability exporter are now logged to the
top-level `tags` row field (which Braintrust surfaces as first-class tags and
filters on) instead of being nested under `metadata.tags`, where they were
invisible to the tag UI. Matching `@mastra/braintrust`, tags are attached only
to the Mastra root span.

Ports mastra-ai/mastra#12057 (re-fixes #9849).
