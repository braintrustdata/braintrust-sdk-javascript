# Braintrust JavaScript SDK Monorepo

TypeScript SDKs and integrations for Braintrust. Uses `pnpm` workspaces.

## Repository Structure

```text
.
├── js/             # Main `braintrust` package
├── integrations/   # Integration packages (@braintrust/*)
├── e2e/            # End-to-end scenario tests (mock server + subprocess isolation)
├── docs/           # Docs and reference material
└── internal/       # Internal test fixtures and golden projects
```

## Setup

```bash
mise install        # Install toolchain and dependencies
```

## Build

```bash
pnpm run build      # Build all workspace packages (from repo root)
```

## Public API

Keep public exports minimal. Generally, export only the requested runtime APIs and do not export types unless explicitly requested.

## Instrumentation

Our vendored Orchestrion implementation is purely internal to the Braintrust SDK.
Downstream packages must not depend on its APIs, config schema, generated helpers, or compatibility with upstream Orchestrion.
Do not expose these internals through SDK entrypoints or public configuration options.
Change the transformer and its SDK callers together, and remove unused upstream features instead of retaining compatibility scaffolding.
Preserve instrumented application behavior, coordination between SDK copies, and upstream license notices.

Use the normal Orchestrion config plus plugin/channel path by default. Special-case source patches should be rare exceptions only when the target SDK cannot be instrumented through the standard transformer path, and the reason should be documented next to the patch.

API wrapping and span instrumentation are separate concepts.
Use `defineInterceptor` to define invocation hooks and `intercept`/`invoke` exclusively as generic wrapping machinery.
Wrapping definitions and runtime code must not depend on spans, tracing lifecycle events, provenance, or SDK initialization.
Keep span creation, context propagation, and finalization in separate tracing functions.
Provider plugins explicitly register those functions through interceptors; tracing helpers accept callables and tracing configuration, never hooks or registration responsibilities.
Do not introduce combined APIs such as `traceInvocation` or `interceptAndTrace`, including internal convenience APIs.
Manual wrappers and generated wrappers only invoke hooks.

Instrumentation patches generally do not need to be removed during teardown. Prefer leaving behavior-preserving patches installed when they are idempotent; do not add unpatching machinery by default.

Span names should generally remain stable across calls and versions. Do not include dynamic values such as model names in span names; record those values in metadata instead.

## Testing

Uses Vitest. Prefer running the **narrowest relevant test** rather than the full suite.

**From `js/` directory:**

```bash
pnpm test                                    # Core vitest suite (excludes wrappers)
pnpm exec vitest run src/foo.test.ts         # Run a single test file
pnpm exec vitest run src/foo.test.ts -t "x"  # Filter by test name within a file
pnpm run test:checks                         # Hermetic tests (core + vitest wrapper)
pnpm run check:typings                       # Typecheck source and test files
```

Do not pass filters through `pnpm test -- ...`; the `--` makes Vitest ignore them and run the full suite.

Vitest does not typecheck. Before opening or updating a pull request, run `pnpm run check:typings` in each package you touched (or from the repo root) so type errors in source or test files are caught before CI.

**E2E tests (`e2e/`):**

Each scenario runs the SDK in a subprocess against a mock Braintrust server and snapshots the results. No API keys required for replay; recording needs provider keys.

Provider e2e tests must aim to exercise actual models with real, valid input data. Populate replay cassettes by recording actual provider responses. Do not substitute fabricated model responses or synthetic provider servers for this coverage. For multimodal scenarios, use valid image, audio, video, and document files. See the [e2e testing skill](.agents/skills/e2e-tests/SKILL.md) for recording guidance.

For real-provider instrumentation tests and e2e recordings, default to cheap models that support the behavior under test, unless the user explicitly requests otherwise. Keep prompts, output limits, and media duration small while preserving meaningful coverage.

```bash
pnpm run test:e2e                 # Run all e2e scenarios (from repo root)
pnpm run test:e2e:update          # Update e2e snapshots without re-recording cassettes
pnpm run test:e2e:record          # Re-record provider cassettes and update snapshots
```

When adding or modifying e2e tests, run the relevant e2e verification twice before stopping so flakes are caught proactively. After running `pnpm run test:e2e:update` or `pnpm run test:e2e:record`, always run the normal e2e tests afterward to verify there is no snapshot drift or unstable output.

New instrumentation e2e coverage must test both a pinned SDK dependency and a separately named latest dependency alias for every supported version line. Only the latest alias should participate in `test:e2e:bump`; add pinned and latest variants to the CI e2e summary.

Span-tree snapshots are paired: `*.span-tree.json` is the structural contract, and `*.span-tree.txt` is the human-readable ASCII tree generated from the same normalized spans. Both files are asserted and should be updated together through `pnpm run test:e2e:update` or `pnpm run test:e2e:record`; do not hand-edit only one side of the pair.

**From repo root:**

```bash
pnpm run test       # Run all workspace tests via turbo
```

## Linting & Formatting

Run from the repo root. **Always run `fix:formatting` before committing** — there is a pre-commit hook that will reject unformatted code.

```bash
pnpm run formatting      # Check formatting (prettier)
pnpm run lint            # Run eslint checks
pnpm run fix:formatting  # Auto-fix formatting
pnpm run fix:lint        # Auto-fix eslint issues
```

## Vendored Forks and Licenses

When touching forked third-party code in this repository, including the
vendored `import-in-the-middle`, `require-in-the-middle`, or `orchestrion-js`
code, preserve and respect the upstream license requirements. Keep copyright
notices, license files, provenance notes, and `js/NOTICE` entries accurate when
copying, updating, or materially modifying vendored code.
