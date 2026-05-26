---
"braintrust": patch
"@braintrust/langchain-js": patch
---

feat: Add LangChain and LangGraph auto-instrumentation. The
`@braintrust/langchain-js` `BraintrustCallbackHandler` now delegates to the
shared implementation in `braintrust`, removing duplicated span/metric
extraction logic.
