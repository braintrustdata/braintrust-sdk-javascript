---
"braintrust": patch
---

fix(pi-coding-agent): preserve system prompts and tool declarations

Capture system instructions and declared tool schemas from Pi 1.4 transcript messages, including section updates and tool additions and removals. Wrap refreshed tool executors from agent state and enable auto-instrumentation for Pi 1.x while preserving legacy context support.
