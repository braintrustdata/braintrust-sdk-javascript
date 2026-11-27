---
"braintrust": patch
---

fix(otel): decode v4 exports in resolveParentHeader

OTLP parent headers accept V4 span exports and preserve their span and root span IDs.
