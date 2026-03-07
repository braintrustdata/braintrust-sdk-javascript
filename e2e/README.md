# E2E Tests

End-to-end tests that validate the Braintrust SDK by running real usage scenarios against a mock Braintrust server.

## How It Works

1. Each test uses `withScenarioHarness(...)`, which starts an isolated mock Braintrust server
2. The test spawns a scenario script as a subprocess, usually with `tsx`
3. The scenario uses the SDK normally (init, create spans, log data, flush, or OTEL / OpenAI integrations)
4. The test inspects captured events, payloads, or raw HTTP requests, then normalizes and snapshots them where useful

Subprocess isolation keeps the SDK execution path close to production, including plain Node runs for auto-instrumentation hook coverage.

## Structure

```
e2e/
|- scenarios/          # Standalone scripts run as subprocesses
|- tests/
|  |- helpers/         # Harness, mock server, normalization, selectors, summaries
|  |- *.test.ts        # Trace, OTEL, and OpenAI coverage
|  `- __snapshots__/   # Vitest snapshots
`- vitest.config.mts
```

## Helpers (`tests/helpers/`)

- `scenario-harness.ts` - Starts the mock server, creates a unique test run id, and runs scenarios.
- `mock-braintrust-server.ts` - Captures requests, merged log payloads, and parsed span-like events.
- `normalize.ts` - Makes snapshots deterministic by normalizing ids, timestamps, paths, and mock-server URLs.
- `trace-selectors.ts` / `trace-summary.ts` - Helpers for finding spans and snapshotting only the relevant shape.
- `openai.ts` - Shared scenario lists and assertions for OpenAI wrapper and hook coverage across v4/v5/v6.

### Writing a new test

Most tests use `withScenarioHarness(async (harness) => { ... })`. It gives each test a fresh server plus helpers for running scenarios and reading what the server captured.

The main utilities you'll use in test files:

- `runScenario(path, timeoutMs?)` - Runs a TypeScript scenario with `tsx`.
- `runNodeScenario(path, nodeArgs?, timeoutMs?)` - Runs plain Node scenarios, used for `--import braintrust/hook.mjs`.
- `testRunEvents()` - Returns parsed events tagged with the current test run id.
- `events()`, `payloads()`, `requestCursor()`, `requestsAfter()` - Lower-level access for ingestion payloads and HTTP request flow assertions.
- `testRunId` - Useful when a scenario or assertion needs the exact run marker.

Use `normalizeForSnapshot(...)` before snapshotting. It replaces timestamps and ids with stable tokens and strips machine-specific paths and localhost ports.

## Running

```bash
pnpm run test:e2e          # Run tests
pnpm run test:e2e:update   # Run tests and update snapshots
```
