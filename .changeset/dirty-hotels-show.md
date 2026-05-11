---
"braintrust": patch
---

OpenAI's `chat.completions.parse()` calls `create()._thenUnwrap(...)`, which produces two `APIPromise` instances sharing the same responsePromise.

Our SDK called `.then()` on each of them, triggered a `parseResponse`, which calls `response.json()` on the HTTP response body. However a `Response` body can only be read once.

Might fix a customer issue https://braintrustdata.slack.com/archives/C0B27UX9UDR/p1778223683547239
