# Playwright Browser Test

Tests the browser build of the Braintrust SDK in a real browser environment using Playwright.

## Design Decisions

### Playwright for Real Browser Testing

Uses Playwright to execute tests in an actual Chromium browser:

- Tests run in real browser context (not jsdom or simulated environment)
- Verifies browser-specific builds and browser APIs work correctly
- Uses esbuild to bundle tests for browser execution

### ESBuild Bundling

Uses esbuild to bundle test code for the browser:

- Bundles the SDK and test code into a single browser-compatible file
- Eliminates need for import maps or module resolution in browser
- Target: ES2020, platform: browser

### Tarball Installation

Uses well-known tarball path for SDK installation:

- `braintrust-latest.tgz` ensures package.json never changes
- Build happens before `pnpm install` to ensure tarball exists

### Shared Test Suites

Imports and executes all shared test suites from `@braintrust/smoke-test-shared`:

- Import verification tests
- Basic logging tests
- Eval smoke tests
- Prompt templating tests

### Test Communication

Tests communicate results via `window.__btBrowserSmokeResults`:

- Browser-side harness collects pass/fail results
- Playwright polls for completion and reads results
- Unhandled errors captured via window event listeners
