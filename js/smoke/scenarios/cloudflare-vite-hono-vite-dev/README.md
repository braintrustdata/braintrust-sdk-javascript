# Cloudflare Vite + Hono Vite Dev Server Test

Tests whether the Braintrust SDK (browser build) can be loaded in Vite's dev server with hot module reloading.

## Design Decisions

**Tarball installation:** Uses well-known tarball path (`braintrust-latest.tgz`) to avoid package.json changes.

**Vite dev server:** Tests SDK through Vite's development server with hot module reloading.

**Hono framework:** Uses Hono for elegant routing instead of raw Worker API.

**Browser build:** Imports `braintrust`; the package's browser condition selects the browser-safe build because Cloudflare Workers don't support Node.js APIs.

## Test Suite

Tests whether the SDK can be loaded in Vite's dev server (with hot module reloading).

**Expected result:** PASS - The browser build should work correctly with Vite dev server.

**Known issue (resolved):** Earlier versions had Nunjucks dependency issues in Vite's ESM bundler. The browser build does not include Nunjucks, so this should work correctly.

## Running Tests

```bash
make test  # Runs the vite dev test
```

**Success criteria:** The test must pass (19 tests: 18 pass, 1 xfail for Nunjucks).
