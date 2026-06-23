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
- `scenario-installer.ts` - Installs optional scenario-local dependencies from a colocated `package.json` into a shared cache and links them into prepared scenario copies.
- `mock-braintrust-server.ts` - Captures requests, merged log payloads, and parsed span-like events.
- `normalize.ts` - Makes snapshots deterministic by normalizing ids, timestamps, paths, and mock-server URLs.
- `trace-selectors.ts` / `span-tree.ts` / `trace-summary.ts` - Helpers for finding spans and snapshotting stable, human-readable trace trees.
- `scenario-runtime.ts` - Shared runtime utilities used by scenario entrypoints.
- `openai.ts` - Shared scenario lists and assertions for OpenAI wrapper and hook coverage across v4/v5/v6.
- `wrapper-contract.ts` - Helpers for snapshotting wrapper span contracts and filtering payload rows by root span id.

### Writing a new test

Most tests use this pattern:

```ts
const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
```

`prepareScenarioDir(...)` copies the scenario into an isolated temp directory and installs optional scenario-local dependencies once per source scenario directory. Reused dependency installs are linked into each prepared copy.

`withScenarioHarness(async (harness) => { ... })` gives each test a fresh server plus helpers for running scenarios and reading what the server captured.

The main utilities you'll use in test files:

- `resolveScenarioDir(import.meta.url)` - Resolves the folder that contains the current test.
- `prepareScenarioDir({ scenarioDir })` - Copies a scenario into a temp directory and links optional scenario-local dependencies.
- `installScenarioDependencies({ scenarioDir })` - Installs optional scenario-local dependencies directly. This is usually only needed when testing installer behavior.
- `runScenarioDir({ scenarioDir, entry?, timeoutMs? })` - Runs a TypeScript scenario with `tsx`.
- `runDenoScenarioDir({ scenarioDir, entry?, args?, timeoutMs? })` - Runs nested Deno scenarios with `deno test`.
- `runNodeScenarioDir({ scenarioDir, entry?, nodeArgs?, timeoutMs? })` - Runs plain Node scenarios, used for `--import braintrust/hook.mjs`.
- `testRunEvents()` - Returns parsed events tagged with the current test run id.
- `events()`, `payloads()`, `requestCursor()`, `requestsAfter()` - Lower-level access for ingestion payloads and HTTP request flow assertions.
- `testRunId` - Useful when a scenario or assertion needs the exact run marker.

Prefer `matchSpanTreeSnapshot(...)` for span snapshots. It asserts both a structural `.span-tree.json` snapshot and a human-readable `.span-tree.txt` tree beside it. Both files are generated from the same normalized span tree and include stable span attributes, input, output, expected values, scores, tags, metadata, metrics, and errors. Use `normalizeForSnapshot(...)` for non-span JSON snapshots; it replaces timestamps and ids with stable tokens and strips machine-specific paths and localhost ports.

### Provider scenario cassettes

External-provider tests pass `runContext: { variantKey, originalScenarioDir }` to the scenario runner. In the default replay lane, missing cassette entries fail loudly instead of skipping or falling back to live provider APIs.

### Wrapper scenario pattern

Wrapper scenarios often create a root span with `testRunId` metadata and then let the wrapper emit child spans that do not repeat that metadata. In those cases:

- Use `events()` rather than `testRunEvents()` to inspect the full trace tree.
- Find the scenario root span first.
- Scope raw payload snapshots by `root_span_id` using `payloadRowsForRootSpan(...)`.
- Prefer normalized span-tree snapshots from `matchSpanTreeSnapshot(...)`. The `.json` sibling is the structural contract, and the `.txt` sibling is the ASCII tree for review; both are asserted and should be updated together.
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

Provider credentials are only required when recording or explicitly running live-provider debugging. Normal e2e replay uses committed cassettes and fails on provider variants that have not been recorded yet. Recording may need:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `AWS_BEARER_TOKEN_BEDROCK`
- `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- `CURSOR_API_KEY`
- `OPENROUTER_API_KEY`
- `MISTRAL_API_KEY`
- `HUGGINGFACE_API_KEY`
- `COHERE_API_KEY`
- `GROQ_API_KEY`

`claude-agent-sdk-instrumentation` also uses `ANTHROPIC_API_KEY`, because it runs the real Claude Agent SDK against Anthropic in the same style as the existing live Anthropic wrapper coverage.

`anthropic-bedrock-instrumentation` uses `AWS_BEARER_TOKEN_BEDROCK`; when recording, its region resolves from `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-east-1`, and its model can be overridden with `BRAINTRUST_ANTHROPIC_BEDROCK_MODEL`.

`test:e2e:canary` runs inside Docker because it installs packages on the latest versions and those packages may contain malicious code (supply-chain attacks).

### Scenario-local `package.json`

Scenario-local manifests are optional and should stay slim. They are only for scenario-specific external dependencies, such as OpenAI version matrices. Shared test tooling and workspace-local packages stay in `e2e/package.json`.

`workspace:` dependency specs are intentionally not supported in scenario-local manifests. If a scenario needs a workspace package, keep that dependency in `e2e/package.json`.

## Running

```bash
pnpm run test:e2e # Run all e2e tests
pnpm run test:e2e:update # Update snapshots in cassette replay mode
pnpm run test:e2e:record # Re-record provider cassettes and update snapshots
pnpm run test:e2e:record -- <name> # Re-record one scenario from the repo root
pnpm run test:e2e:canary # Run canary e2e tests
```

## Cassettes (provider HTTP record/replay)

The mock Braintrust server captures **outbound** SDK→Braintrust traffic and snapshots it under `__snapshots__/`. Cassettes capture the opposite direction: provider HTTP responses (OpenAI, Anthropic, ...) so e2e tests don't have to hit real provider APIs in CI.

The cassette layer is backed by the internal `@braintrust/seinfeld` workspace package. For e2e tests, the harness starts a local cassette HTTP server and points provider SDK base URLs at that server.

- **Layer:** `withScenarioHarness(...)` starts a `createCassetteServer()` instance for cassette-enabled scenario runs. Provider base URL env vars (for OpenAI, Anthropic, Anthropic Bedrock, Google, Cohere, Cursor, Groq, HuggingFace, Mistral, OpenRouter, and the GitHub Copilot SDK's OpenAI provider mode) point at route prefixes on that server, so subprocesses and SDK-launched binaries can be captured too.
- **Auto-engage:** the harness automatically engages the cassette layer when (a) a scenario run has `runContext.variantKey`, (b) a cassette JSON exists for the scenario+variant on disk, OR (c) `BRAINTRUST_E2E_CASSETTE_MODE` is `record` / `record-missing`. Scenarios just need to thread `runContext: { variantKey, originalScenarioDir }` into their runner calls — no other code change required.
- **Provider replay failures:** provider scenarios are not skipped when a cassette is missing. In replay mode, the cassette server still starts from `runContext.variantKey`, injects placeholder provider keys, and fails on cassette misses instead of silently calling a live provider.
- **Mode** is set by `BRAINTRUST_E2E_CASSETTE_MODE`:
  - `replay` (default; what CI uses): match the cassette or fail loudly.
  - `record`: overwrite the cassette with a fresh recording from the live API.
  - `passthrough`: keep provider base URLs pointed at the local server, but proxy requests to the live provider without recording. Local debugging only.

### Re-recording cassettes (one-time setup per provider)

Cassettes for a scenario can be recorded by anyone with the relevant provider keys; the resulting JSON is committed to git and the scenario then replays in CI without provider credentials. The e2e suite auto-loads `.env` and `.env.local` from the repo root via `vitest.setup.ts`, so you can either set keys in your shell or drop them in `.env`. The record command also updates Vitest snapshots.

```bash
# With .env populated:
pnpm --filter=@braintrust/js-e2e-tests run test:e2e:record

# One scenario only, from the repo root:
pnpm run test:e2e:record -- <name>

# One scenario only, through the e2e workspace package:
pnpm --filter=@braintrust/js-e2e-tests run test:e2e:record -- <name>

# Or via shell env:
ANTHROPIC_API_KEY=... AWS_BEARER_TOKEN_BEDROCK=... \
OPENAI_API_KEY=... GEMINI_API_KEY=... \
COHERE_API_KEY=... GROQ_API_KEY=... HUGGINGFACE_API_KEY=... \
MISTRAL_API_KEY=... OPENROUTER_API_KEY=... \
CURSOR_API_KEY=... \
  pnpm --filter=@braintrust/js-e2e-tests run test:e2e:record
```

After recording, run again **without any provider keys** to confirm the cassette is sufficient:

```bash
unset ANTHROPIC_API_KEY AWS_BEARER_TOKEN_BEDROCK OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_API_KEY COHERE_API_KEY GROQ_API_KEY HUGGINGFACE_API_KEY MISTRAL_API_KEY OPENROUTER_API_KEY CURSOR_API_KEY
pnpm --filter=@braintrust/js-e2e-tests run test:e2e
```

If a scenario records but later replay fails because of volatile fields in the request body (e.g. AI-SDK's generated message ids), add or update `<scenario-dir>/cassette-filter.mjs` for that scenario, then re-record.

After any successful record run, stale cassette variants are cleaned only inside scenarios that emitted cassette run-context records during that run. With explicit scenario names, cleanup is limited to those scenarios; with a full record run, cleanup applies to every observed cassette-backed scenario. Per-cassette blob sidecar cleanup still happens in the cassette file store when each cassette is saved.

### In-scope scenarios

These scenarios have cassette wiring in place and will use cassettes once they're recorded:

`anthropic-bedrock-instrumentation`, `anthropic-instrumentation`, `openai-instrumentation`, `openai-codex-instrumentation`, `ai-sdk-instrumentation`, `ai-sdk-otel-export`, `claude-agent-sdk-instrumentation`, `cohere-instrumentation`, `cursor-sdk-instrumentation`, `github-copilot-instrumentation`, `google-adk-instrumentation`, `google-genai-instrumentation`, `groq-instrumentation`, `huggingface-instrumentation`, `mistral-instrumentation`, `openrouter-agent-instrumentation`, `openrouter-instrumentation`, `wrap-langchain-js-traces`.

### Cassette format

Cassettes use the `@braintrust/seinfeld` JSON format. Bodies are stored as `{ kind: 'json', value }`, `{ kind: 'sse', chunks }`, `{ kind: 'text', value }`, or `{ kind: 'binary', path, sha256 }`. Large binary bodies live in `.cassette.blobs/` sidecar directories. Volatile headers (auth, request ids, rate limits, transport encodings) are stripped during recording by the `'paranoid'` redaction preset.
