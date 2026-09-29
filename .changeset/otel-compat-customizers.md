---
"@braintrust/otel": patch
---

fix: Log an error from `setupOtelCompat()` when Braintrust span customizers are registered, since they are not yet supported with OpenTelemetry compat mode. Log once per setup attempt and continue enabling compat mode without clearing the registered customizers.
