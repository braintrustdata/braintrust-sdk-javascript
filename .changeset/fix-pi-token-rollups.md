---
"braintrust": patch
---

fix(pi-coding-agent): avoid double-counting token usage and cost

Keep token usage on child LLM spans instead of repeating it on AgentSession.prompt task spans, so trace rollups count each provider call once.
