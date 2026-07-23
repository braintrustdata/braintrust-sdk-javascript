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

## Instrumentation

Use the normal Orchestrion config plus plugin/channel path by default. Special-case source patches should be rare exceptions only when the target SDK cannot be instrumented through the standard transformer path, and the reason should be documented next to the patch.

Instrumentation patches generally do not need to be removed during teardown. Prefer leaving behavior-preserving patches installed when they are idempotent; do not add unpatching machinery by default.

## Testing

Uses Vitest. Prefer running the **narrowest relevant test** rather than the full suite.

**From `js/` directory:**

```bash
pnpm test                         # Core vitest suite (excludes wrappers)
pnpm test -- -t "test name"       # Filter by test name
pnpm run test:checks              # Hermetic tests (core + vitest wrapper)
```

**E2E tests (`e2e/`):**

Each scenario runs the SDK in a subprocess against a mock Braintrust server and snapshots the results. No API keys required for replay; recording needs provider keys.

```bash
pnpm run test:e2e                 # Run all e2e scenarios (from repo root)
pnpm run test:e2e:update          # Update e2e snapshots without re-recording cassettes
pnpm run test:e2e:record          # Re-record provider cassettes and update snapshots
```

When adding or modifying e2e tests, run the relevant e2e verification twice before stopping so flakes are caught proactively. After running `pnpm run test:e2e:update` or `pnpm run test:e2e:record`, always run the normal e2e tests afterward to verify there is no snapshot drift or unstable output.

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
