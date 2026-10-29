---
"braintrust": patch
---

fix(pi): align agent instrumentation with tracing spec

Capture nested session tool calls and their application spans, record tool
approval only when execution is observed, and preserve tracing context across
SDK copies. Align Pi errors, attachments, usage metrics, and metadata with the
instrumentation specification.
