---
"braintrust": patch
---

fix(livekit): Finish uploading recordings before `session.close()` resolves, so they are not lost when the job process exits
