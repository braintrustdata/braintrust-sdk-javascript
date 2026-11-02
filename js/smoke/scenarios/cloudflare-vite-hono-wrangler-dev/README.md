# Cloudflare Vite + Hono Wrangler Dev Test

Tests Braintrust SDK in a Cloudflare Workers environment with Vite bundling via Wrangler dev server.

## Design Decisions

**Tarball installation:** Uses well-known tarball path (`braintrust-latest.tgz`) to avoid package.json changes.

**Vite bundling:** Tests SDK through Vite's production bundler for Cloudflare Workers via Wrangler.

**Hono framework:** Uses Hono for elegant routing instead of raw Worker API.

**Browser build:** Imports `braintrust`; the package's browser condition selects the browser-safe build because Cloudflare Workers don't support Node.js APIs.

**Wrangler dev:** Tests via Wrangler dev server, which uses Vite to build the worker.

## Test Suite

Tests the SDK via Wrangler dev server, which uses Vite to build the worker.

**Expected results:** 19 tests total - 18 pass + 1 xfail (Nunjucks). Overall: **PASS**.

**Expected failure handling:** Nunjucks templating is tested but expected to fail in browser builds. The test converts this failure to "xfail" (expected failure) status, so it doesn't cause the overall test run to fail.

**Why test Nunjucks if it fails?** Testing both template engines ensures:

- Mustache templating works correctly (browser-compatible)
- We detect if Nunjucks support changes in future Cloudflare Workers versions
- Consistent test coverage across all environments (Node.js scenarios pass both)

## Running Tests

```bash
make test  # Runs the wrangler dev test
```

**Success criteria:** The test must pass (18 pass, 1 xfail).
