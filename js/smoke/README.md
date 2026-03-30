# Braintrust JS SDK Smoke Tests v2

Smoke test infrastructure verifying SDK installation across different runtimes and integrations.

## Quick Reference

```bash
# From sdk/js/:
make test-smoke                    # Run all scenarios

# From sdk/js/smoke/:
make test                          # Run all scenarios (local + integration)
make test templates-nunjucks/jest  # Run integration scenario
make list                          # List all discovered scenarios

# From a specific scenario:
cd scenarios/<scenario-name>
make test                          # Auto-creates tarball if needed
```

## Output Standardization (REQUIRED)

**ALL test files MUST use `displayTestResults()` from the shared package:**

```typescript
import {
  runTests,
  expectFailure,
  testBasicSpanLogging,
  testMultipleSpans,
  // ... other test functions
} from "../../shared/dist/index.mjs";

import * as braintrust from "braintrust";

// Run tests with the new runTests helper
const { all, passed, failed, xfail } = await runTests({
  name: "My Scenario Test Results",
  braintrust,
  tests: [
    testBasicSpanLogging,
    testMultipleSpans,
    expectFailure(
      testNunjucksTemplate,
      (e) => e.message.includes("not supported"),
      "Nunjucks not supported in browser build",
    ),
  ],
});

// Check for failures
if (failed.length > 0) {
  process.exit(1);
}
```

**Key features:**

- `runTests()` automatically displays results, validates coverage, and returns structured results
- `expectFailure()` wraps tests expected to fail with error predicate validation
- No manual `try/catch` blocks needed around `runTests()`
- No manual coverage validation needed

## Creating a New Scenario

### Requirements

- [ ] Makefile with `setup` and `test` targets
- [ ] Environment spec (mise.toml, deno.json, etc.)
- [ ] Dependencies declared (package.json, deno.json, etc.)
- [ ] README.md explaining design decisions (15-25 lines)
- [ ] .gitignore (ignore artifacts, track lock files)
- [ ] **Tests use `runTests()` and individual test functions**
- [ ] **Minimal logging** (errors only)
- [ ] **POSIX shell syntax** (`[ ]` not `[[ ]]`)

### Patterns

**Node.js + npm:** Use tarball paths in package.json. See `scenarios/otel-v1/`.

**Multi-test:** Each test uses `displayTestResults()`. Makefile runs all tests (don't fail early), then exits with failure if any failed. See `scenarios/otel-v1/` for example.

### Example Test File

```typescript
import {
  runTests,
  expectFailure,
  testBasicSpanLogging,
  testMultipleSpans,
  testDirectLogging,
  testCoreLoggingExports,
  testBuildResolution,
  testNunjucksTemplate,
} from "../../shared";

import * as braintrust from "braintrust";

async function main() {
  const { all, passed, failed, xfail } = await runTests({
    name: "My Scenario Test Results",
    braintrust,
    tests: [
      // Import verification tests
      testCoreLoggingExports,
      testBuildResolution,

      // Functional tests
      testBasicSpanLogging,
      testMultipleSpans,
      testDirectLogging,

      // Expected failures with error validation
      expectFailure(
        testNunjucksTemplate,
        (e) => e.message.includes("not supported"),
        "Nunjucks not supported in browser build",
      ),
    ],
  });

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### Example HTTP Endpoint (Cloudflare Workers, Next.js)

```typescript
import {
  runTests,
  expectFailure /* ... test functions */,
} from "../../../shared";
import * as braintrust from "braintrust";

app.get("/api/test", async (c) => {
  const { all, passed, failed, xfail } = await runTests({
    name: "My Worker Test Results",
    braintrust,
    tests: [
      testBasicSpanLogging,
      testMultipleSpans,
      expectFailure(
        testNunjucksTemplate,
        (e) => e.message.includes("Disallowed"),
        "Cloudflare Workers blocks dynamic code generation",
      ),
    ],
  });

  return c.json(
    {
      success: failed.length === 0,
      message:
        failed.length > 0
          ? `${failed.length} test(s) failed`
          : "All tests passed",
      totalTests: all.length,
      passedTests: passed.length,
      failedTests: failed.length,
      xfailTests: xfail.length,
      results: all,
    },
    failed.length === 0 ? 200 : 500,
  );
});
```

### Example Makefile (Multiple Tests)

**IMPORTANT:** Run all tests even if one fails. Don't exit early.

```makefile
test: setup
	@echo "==> Running tests"
	@FAILED=0; \
	npx tsx tests/test1.test.ts || FAILED=1; \
	npx tsx tests/test2.test.ts || FAILED=1; \
	npx tsx tests/test3.test.ts || FAILED=1; \
	exit $$FAILED
```

This ensures all tests run and display their results, but the suite still fails if any test failed.

## Environment Variables & Tarball Creation

### Automatic Tarball Creation

Scenarios automatically create tarballs if they're not provided via environment variables. This happens during the `setup` target:

1. **Check for existing tarball**: If `BRAINTRUST_TAR` env var is set and points to a valid file, use it
2. **Build from source**: Otherwise, build SDK and create tarball:

   ```bash
   cd ../../.. && pnpm exec turbo build --filter=braintrust && \
   mkdir-p artifacts && pnpm pack --pack-destination artifacts
   ```

3. **Rename to well-known path**: Copy to `braintrust-latest.tgz` for consistent references

### Environment Variables

- **`BRAINTRUST_TAR`**: Path to braintrust tarball (auto-created if not set)
  - Example: `../artifacts/braintrust-latest.tgz`

- **`BRAINTRUST_OTEL_TAR`**: Path to @braintrust/otel tarball (auto-created for scenarios that need it)
  - Example: `../artifacts/braintrust-otel-latest.tgz`

- **`BRAINTRUST_TEMPLATES_NUNJUCKS_JS_TAR`**: Path to @braintrust/templates-nunjucks-js tarball
  - Example: `../artifacts/braintrust-templates-nunjucks-js-latest.tgz`

- **`SMOKE_V2_SHARED_DIST`**: Path to shared test utilities (auto-built if not set)
  - Example: `shared/dist`

### Local vs CI Execution

**Locally:**

- Tarballs auto-created on first run
- Cached for subsequent runs (fast)
- Run from any level: `sdk/js/`, `sdk/js/smoke/`, or scenario directory

**In CI** (`.github/workflows/checks.yaml`):

1. **`js-build` job**: Creates all tarballs (braintrust, otel, templates-nunjucks), uploads as artifacts
2. **`js-smoke-discover` job**: Auto-discovers all scenarios (local + integration)
3. **`js-smoke-test` job**: Downloads tarballs, runs all scenarios in parallel with `fail-fast: false`

## Integration Scenarios

Integration scenarios test SDK integrations and are located under `../../integrations/*/scenarios/`:

### Templates-Nunjucks

- **templates-nunjucks/basic-render**: Basic Nunjucks template rendering
- **templates-nunjucks/deno**: Deno runtime with Nunjucks
- **templates-nunjucks/jest**: Jest test runner with Nunjucks
- **templates-nunjucks/nextjs**: Next.js integration with Nunjucks

### OpenTelemetry (OTel)

- **otel-js/otel-v1**: OpenTelemetry smoke test scenario (using shared test suite)

Note: The `otel-js/otel-v1` and `otel-js/otel-v2` directories at the root of `integrations/otel-js/` are integration test environments (not smoke tests) and use a different test runner (vitest).

All integration scenarios are automatically discovered and run alongside local scenarios.

## Design Principles

### Well-Known Tarball Paths

Use version-agnostic paths: `braintrust-latest.tgz` not `braintrust-2.0.2.tgz`. Prevents package.json from changing on version bumps.

### No Workarounds

Never use `--legacy-peer-deps`, `--no-check`, `--ignore-errors`, or mocks. Smoke tests must expose issues users will encounter.

### No Defensive Checks in Tests

Don't conditionally check if functions exist before calling them. Let natural JavaScript errors occur and get caught by the test framework. This provides:

- **Better error messages**: Stack traces show exactly where/what failed
- **Cleaner test code**: No redundant existence checks
- **Real-world behavior**: Tests fail the same way user code would fail

```typescript
// ❌ Bad - defensive checks hide the real error
if (!braintrust.traced) {
  return { status: "fail", error: { message: "traced missing" } };
}

// ✓ Good - let it throw naturally (register() wraps this)
const traced = braintrust.traced as TracedFn;
await traced(
  () => {
    /* ... */
  },
  { name: "test" },
);
```

### Build Before Install

Build all artifacts BEFORE installing dependencies that reference them. Prevents "ENOENT" errors.

### Track Lock Files

Commit `package-lock.json` and `deno.lock`. Changes signal new dependencies, version conflicts, or packaging issues.

### Makefiles Are the Source of Truth

No npm scripts in package.json. All commands in Makefile. Single clear path to run tests.

## Troubleshooting

### "ENOENT: no such file or directory" for tarball

Ensure Makefile builds packages BEFORE `npm install`.

### "Unsupported URL Type 'workspace:'"

Use `pnpm pack` (not `npm pack`) for packages with `workspace:*` dependencies.

### package.json gets modified by npm

Use well-known tarball paths: `braintrust-latest.tgz` not version-specific paths.

### Tests can't find braintrust imports

Verify tarball paths in package.json are correct relative to scenario directory.

## Directory Structure

```
smoke/
├── shared/          # Cross-scenario test utilities
├── scenarios/       # Individual test scenarios
│   ├── otel-v1/
│   │   ├── tests/         # Test files
│   │   ├── Makefile       # setup + test targets
│   │   ├── mise.toml      # Environment definition
│   │   ├── package.json   # Dependencies only (no scripts)
│   │   └── README.md
├── Makefile         # Top-level orchestration (auto-discovery)
└── README.md        # This file
```

## How Auto-Discovery Works

The top-level Makefile finds scenarios:

```makefile
SCENARIOS := $(shell find scenarios -mindepth 1 -maxdepth 1 -type d -exec test -f {}/Makefile \; -print | sed 's|scenarios/||')
```

Any folder in `scenarios/` with a `Makefile` is automatically discovered. No registration needed.

## Shared Test Suites

The `shared/` package provides reusable test suites that run across all scenarios:

- **Import Verification** - Verifies SDK exports exist, prevents tree-shaking issues
- **Basic Logging** - Core logging functionality including Async Local Storage (ALS) tests
- **Prompt Templating** - Mustache (all environments) and Nunjucks (Node.js)
- **Eval Smoke Test** - Basic eval functionality

See `shared/README.md` for complete test suite documentation, individual test functions, and implementation details.

## Reference Scenarios

- **Node.js + OTEL:** `scenarios/otel-v1/`
- **Cloudflare Workers:** `scenarios/cloudflare-worker-*/`
- **Multi-test:** `scenarios/cloudflare-vite-hono/`
