---
"braintrust": patch
---

fix(livekit): Flush a session's rows before LiveKit's job process exits

LiveKit ends its job process with `process.exit()`, which skips the SDK's exit flush. Rows logged while a session closed, including its final recording segment, could be lost; closing a session now waits for them to be sent.
