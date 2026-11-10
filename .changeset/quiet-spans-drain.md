---
"braintrust": patch
---

fix: serialize span-cache disk flushes so each queued record is written once and waiting for pending writes covers the whole drain.
