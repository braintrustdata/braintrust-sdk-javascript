# Browser Main Package Smoke Test

This smoke test verifies the curated browser API exposed by the main `braintrust` package.

## What This Tests

When a user imports from the main `braintrust` package in a browser environment:

```typescript
import * as braintrust from "braintrust";
```

The package's browser export condition resolves to `dist/browser.mjs`, which should:

1. Provide working browser-safe implementations
2. Expose the supported root API
3. Omit removed legacy and internal exports
4. Not include Node.js modules

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
✓ Supported functions are available (`init`, `flush`)
✓ Legacy exports such as `newId` and `traceable` are absent
✓ No Node.js module errors
