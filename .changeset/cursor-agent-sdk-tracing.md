---
"braintrust": minor
---

feat(cursor-sdk): Trace Cursor Agent SDK turns

Instrument the minified `@cursor/sdk` ESM and CommonJS builds, record reported run usage and tool status, and add `cursorAgentSDKHookEvents()` for attaching Agent SDK session and turn ids to Cursor Agent spans.
