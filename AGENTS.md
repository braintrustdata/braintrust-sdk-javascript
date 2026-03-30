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
mise install        # Install toolchain, dependencies, and agent skills
```

## Build

```bash
pnpm run build      # Build all workspace packages (from repo root)
```

## Testing

Uses Vitest. Prefer running the **narrowest relevant test** rather than the full suite.

**From `js/` directory:**

```bash
pnpm test                         # Core vitest suite (excludes wrappers)
pnpm test -- -t "test name"       # Filter by test name
pnpm run test:checks              # Hermetic tests (core + vitest wrapper)
```

**Provider wrapper tests (require API keys):**

```bash
pnpm run test:external:openai
pnpm run test:external:anthropic
pnpm run test:external:google-genai
pnpm run test:external:ai-sdk
pnpm run test:external:claude-agent-sdk
```

```bash
# Required env vars for provider tests
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

**E2E tests (`e2e/`):**

Each scenario runs the SDK in a subprocess against a mock Braintrust server and snapshots the results. No API keys required.

```bash
pnpm run test:e2e                 # Run all e2e scenarios (from repo root)
pnpm run test:e2e:update          # Run and update snapshots
```

**From repo root:**

```bash
pnpm run test       # Run all workspace tests via turbo
```

## Linting & Formatting

Run from the repo root. **Always run formatting before committing** — there is a pre-commit hook that will reject unformatted code.

```bash
pnpm run formatting      # Check formatting (prettier)
pnpm run lint            # Run eslint checks
pnpm run fix:formatting  # Auto-fix formatting
pnpm run fix:lint        # Auto-fix eslint issues
```
