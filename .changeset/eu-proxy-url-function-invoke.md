---
"braintrust": patch
---

Fix `405 Method POST not supported` when invoking functions (e.g. `initFunction`/`Eval` scorers) on EU and self-hosted data planes. These orgs' login response sets `proxy_url` to `{apiUrl}/v1/proxy`, but the `function/*` endpoints reached via `proxyConn` are served at the API host root; the proxy connection now strips a trailing `/v1/proxy` so requests resolve correctly on all data planes.
