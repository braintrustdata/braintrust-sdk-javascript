---
"braintrust": patch
---

fix: Ignore empty numeric environment variables such as `BRAINTRUST_NUM_RETRIES` and `BRAINTRUST_DEFAULT_BATCH_SIZE` instead of reading them as `0`
