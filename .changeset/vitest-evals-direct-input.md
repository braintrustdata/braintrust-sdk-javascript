---
"braintrust": minor
---

feat(vitest-evals): support a direct `input` on eval task meta, mirroring `output`

Previously the only way to populate an eval row's `input` field was via
`harness.run.session.messages` (the first message with `role: "user"`), which
forces non-conversational harnesses to fabricate a synthetic message just to
surface their real input. `meta.eval.input` now works exactly like the
existing `meta.eval.output`: a direct passthrough that takes precedence over
`session.messages` when present, falling back to the previous behavior when
it's not set.
