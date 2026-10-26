---
"braintrust": minor
---

feat(logger): batch log rows with a short flush delay

Batch nearby log rows into fewer HTTP requests in long-lived Node processes. Rows wait up to 1s before flushing, so call `flush()` before shutting down on signals or `process.exit()`. Configure the delay with `BRAINTRUST_FLUSH_DELAY_MS`; serverless and other runtimes continue to flush immediately by default.
