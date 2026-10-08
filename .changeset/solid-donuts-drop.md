---
"braintrust": minor
---

feat(livekit): add automatic voice traces and optional recordings

Add automatic LiveKit Agents tracing through the standard loader and logger, with turn, transcript, model, synthesis, and tool spans for cascade and realtime sessions. Preserve native usage and selected LiveKit metadata, and suppress redundant provider spans only within tracked inference work.

Support opt-in caller and agent recordings through the optional `@braintrust/audio` package, with direct playback selections on turns and speaking spans. Default recordings to Ogg; preserve text and metadata tracing when the extension is unavailable. Include `braintrust/livekit` APIs for manually managed telemetry.
