---
"braintrust": patch
---

fix(tracing): preserve span ids in v4 parent exports

V4 span exports preserve the original spelling of span and root span IDs when they cannot be encoded losslessly as binary hex.
