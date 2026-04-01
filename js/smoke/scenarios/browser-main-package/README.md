# Browser Main Package Smoke Test

This smoke test verifies that the informational message appears when using the browser build from the main `braintrust` package.

## What This Tests

When a user imports from the main `braintrust` package in a browser environment:

```typescript
import * as braintrust from "braintrust";
```

The bundler (via the `"browser"` field in package.json) will resolve to the browser build (`dist/browser.mjs`), which should:

1. Show an informational console message suggesting `@braintrust/browser` for optimal use
2. Provide working browser-safe implementations
3. Not include Node.js modules

## Test Structure

- **src/browser-message-test.ts** - Browser test script that imports from main package
- **pages/browser-message-test.html** - HTML page to run the test
- **tests/browser-message.test.ts** - Playwright test that verifies the message

## Running the Test

```bash
make test
```

Or step by step:

```bash
# Install dependencies
make install

# Build the test bundle
make build

# Run Playwright tests
pnpm exec playwright test
```

## What Gets Verified

✓ Import from main package works in browser
✓ Basic functions are available (init, newId, traceable)
✓ Informational message appears in console
✓ Message mentions "@braintrust/browser" package
✓ No Node.js module errors

## Expected Console Output

When the test runs, you should see:

```
Braintrust SDK Browser Build
You are using a browser-compatible build from the main package.
For optimal browser support consider:
  npm install @braintrust/browser
  import * as braintrust from "@braintrust/browser"
```

This message guides users toward the optimized `@braintrust/browser` package while ensuring the main package works correctly in browsers.
