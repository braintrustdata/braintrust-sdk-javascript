---
"braintrust": patch
---

fix(mastra): Emit Mastra tags as first-class Braintrust tags

Root-span tags from the Mastra observability exporter are now additionally
logged to the top-level `tags` row field, which Braintrust surfaces as
first-class tags and filters on. Previously tags were only nested under
`metadata.tags`, where they were invisible to the tag UI. Matching
`@mastra/braintrust`, the first-class tags are attached only to the Mastra root
span. The existing `metadata.tags` field is retained for backward
compatibility, so this change is purely additive.

Note: Braintrust's trace-list tag filter is scoped to the trace root span
(`is_root`). In the zero-config and manual integrations the Mastra root span is
the Braintrust trace root, so tags are filterable everywhere. When Mastra runs
nested inside an existing Braintrust span, the tags land on a non-root span:
they remain filterable via summary / BTQL (which aggregates tags across all
spans in a trace) but not via the root-scoped trace-list form filter.

Ports mastra-ai/mastra#12057 (re-fixes #9849).
