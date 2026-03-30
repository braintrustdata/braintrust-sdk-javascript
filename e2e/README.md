# E2E Tests

End-to-end tests that validate the Braintrust SDK by running real usage scenarios against a mock Braintrust server.

## How It Works

1. Each colocated `scenario.test.ts` file uses `withScenarioHarness(...)`, which starts an isolated mock Braintrust server.
2. The test resolves its own scenario folder and spawns a scenario entrypoint as a subprocess.
3. The scenario uses the SDK normally (init, create spans, log data, flush, or OTEL / OpenAI integrations).
4. The test inspects captured events, payloads, or raw HTTP requests, then normalizes and snapshots them where useful.

Subprocess isolation keeps the SDK execution path close to production, including plain Node runs for auto-instrumentation hook coverage.

## Structure

```text
e2e/
|- helpers/            # Shared harness, mock server, normalization, selectors, summaries
|- scenarios/
|  `- <scenario-name>/
|     |- scenario.ts          # Default tsx entrypoint
|     |- scenario.mjs         # Default plain-Node entrypoint when needed
|     |- scenario.test.ts     # Colocated Vitest suite
|     |- package.json         # Optional slim scenario-local deps
|     `- __snapshots__/       # Colocated snapshots
`- vitest.config.mts
```

Any extra files needed only by one scenario stay in that scenario folder. Anything reused by multiple scenarios belongs in `e2e/helpers/`.

## Helpers (`helpers/`)

- `scenario-harness.ts` - Starts the mock server, creates a unique test run id, resolves scenario directories, and runs scenario folders.
- `scenario-installer.ts` - Installs optional scenario-local dependencies from a colocated `package.json`.
- `mock-braintrust-server.ts` - Captures requests, merged log payloads, and parsed span-like events.
- `normalize.ts` - Makes snapshots deterministic by normalizing ids, timestamps, paths, and mock-server URLs.
- `trace-selectors.ts` / `trace-summary.ts` - Helpers for finding spans and snapshotting only the relevant shape.
- `scenario-runtime.ts` - Shared runtime utilities used by scenario entrypoints.
- `openai.ts` - Shared scenario lists and assertions for OpenAI wrapper and hook coverage across v4/v5/v6.
- `wrapper-contract.ts` - Helpers for snapshotting wrapper span contracts and filtering payload rows by root span id.

### Writing a new test

Most tests use this pattern:

```ts
const scenarioDir = resolveScenarioDir(import.meta.url);

beforeAll(async () => {
  await installScenarioDependencies({ scenarioDir });
});
```

`installScenarioDependencies(...)` is optional and only needed when the scenario folder has its own `package.json`.

`withScenarioHarness(async (harness) => { ... })` gives each test a fresh server plus helpers for running scenarios and reading what the server captured.

The main utilities you'll use in test files:

- `resolveScenarioDir(import.meta.url)` - Resolves the folder that contains the current test.
- `installScenarioDependencies({ scenarioDir })` - Installs optional scenario-local dependencies.
- `runScenarioDir({ scenarioDir, entry?, timeoutMs? })` - Runs a TypeScript scenario with `tsx`.
- `runDenoScenarioDir({ scenarioDir, entry?, args?, timeoutMs? })` - Runs nested Deno scenarios with `deno test`.
- `runNodeScenarioDir({ scenarioDir, entry?, nodeArgs?, timeoutMs? })` - Runs plain Node scenarios, used for `--import braintrust/hook.mjs`.
- `testRunEvents()` - Returns parsed events tagged with the current test run id.
- `events()`, `payloads()`, `requestCursor()`, `requestsAfter()` - Lower-level access for ingestion payloads and HTTP request flow assertions.
- `testRunId` - Useful when a scenario or assertion needs the exact run marker.

Use `normalizeForSnapshot(...)` before snapshotting. It replaces timestamps and ids with stable tokens and strips machine-specific paths and localhost ports.

### Test tags

Hermetic tests (those that use only the mock Braintrust server and local fixtures) must be tagged with `E2E_TAGS.hermetic` from `e2e/helpers/tags.ts`. This allows CI to run hermetic tests separately without provider credentials.

Tests that call real provider APIs do not need a tag.

```ts
import { E2E_TAGS } from "../../helpers/tags";

test(
  "trace-primitives-basic collects a minimal manual trace tree",
  { tags: [E2E_TAGS.hermetic] },
  async () => {
    // ...
  },
);
```

### Wrapper scenario pattern

Wrapper scenarios often create a root span with `testRunId` metadata and then let the wrapper emit child spans that do not repeat that metadata. In those cases:

- Use `events()` rather than `testRunEvents()` to inspect the full trace tree.
- Find the scenario root span first.
- Scope raw payload snapshots by `root_span_id` using `payloadRowsForRootSpan(...)`.
- Pair a normalized `span-events` snapshot with a normalized `log-payloads` snapshot.
- If the wrapper has an explicit support matrix, reuse one shared test across version-specific scenario entries instead of duplicating the assertions. The AI SDK wrapper scenario uses this for supported v3-v6 package combinations.

### Runner-wrapper scenario pattern

Some wrappers execute inside a nested test runner rather than a single SDK call. The Vitest and `node:test` wrapper scenarios use this pattern:

- Keep the outer e2e suite in `scenario.test.ts` and the spawned runner entrypoint in `scenario.ts`.
- Put nested runner source in files like `runner.case.ts` or `runner.case.mjs`.
- Do not name nested runner files `*.test.ts`, because the outer `e2e/vitest.config.mts` includes `scenarios/**/*.test.ts` and will try to execute them directly.
- Tag every traced test/eval with `metadata.testRunId` so the outer assertions can isolate rows across multiple trace roots with `payloadRowsForTestRunId(...)`.
- If a nested runner needs its own test discovery rules, keep that config local to the scenario folder so the shared e2e config stays unchanged.

The Deno scenarios follow the same pattern, except the harness invokes `deno test` via `runDenoScenarioDir(...)` and the nested runner entrypoint lives in `runner.case.ts`.

### Environment variables

Non-hermetic scenarios require provider credentials in addition to the mock Braintrust server config supplied by the harness:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- `OPENROUTER_API_KEY`

`claude-agent-sdk-instrumentation` also uses `ANTHROPIC_API_KEY`, because it runs the real Claude Agent SDK against Anthropic in the same style as the existing live Anthropic wrapper coverage.

### Scenario-local `package.json`

Scenario-local manifests are optional and should stay slim. They are only for scenario-specific external dependencies, such as OpenAI version matrices. Shared test tooling and workspace-local packages stay in `e2e/package.json`.

`workspace:` dependency specs are intentionally not supported in scenario-local manifests. If a scenario needs a workspace package, keep that dependency in `e2e/package.json`.

## Running

```bash
pnpm run test:e2e            # Run all e2e tests
pnpm run test:e2e:hermetic   # Run hermetic-only e2e tests
pnpm run test:e2e:update     # Run tests and update snapshots
```
