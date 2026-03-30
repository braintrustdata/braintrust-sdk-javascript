# Braintrust Smoke Test Shared Package

Shared test utilities and suites for Braintrust SDK smoke tests across multiple runtime environments.

## Purpose

This package provides reusable test logic that can be imported and run in different JavaScript/TypeScript environments (Node.js, Deno, Cloudflare Workers, etc.) to verify the Braintrust SDK works correctly after build and bundling.

### Why Shared Tests?

1. **DRY Principle**: Write test logic once, run it everywhere
2. **Tree Shaking Coverage**: Different bundlers (webpack, esbuild, Deno's bundler) handle imports differently. Running the same tests across multiple environments helps catch export/import issues that only surface in specific bundlers.
3. **Consistency**: Ensure the SDK behaves identically across all supported environments
4. **Maintainability**: Add new test coverage in one place, automatically available everywhere

## Build Outputs

The package is built with `tsup` to produce both CommonJS and ESM formats:

- `dist/index.js` - CommonJS build
- `dist/index.mjs` - ESM build
- `dist/index.d.ts` / `dist/index.d.mts` - TypeScript declarations

This allows the same test code to be imported in both CJS and ESM environments.

## Structure

```
shared/
├── src/
│   ├── helpers/
│   │   ├── types.ts          # Shared type definitions
│   │   ├── register.ts       # Test registration and runner
│   │   ├── assertions.ts     # Assertion utilities
│   │   └── display.ts        # Result display utilities
│   ├── suites/
│   │   ├── basic-logging.ts       # Basic logging test suite
│   │   ├── import-verification.ts # Import/export verification
│   │   ├── prompt-templating.ts   # Prompt templating tests
│   │   └── eval-smoke.ts          # Eval functionality tests
│   └── index.ts              # Main exports
├── dist/                     # Build output (gitignored)
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Building

```bash
cd smoke/shared
npm install
npm run build
```

This produces both CJS and ESM builds in the `dist/` directory.

## Usage

### Basic Pattern

```typescript
import {
  runTests,
  expectFailure,
  testBasicSpanLogging,
  testMultipleSpans,
  testNunjucksTemplate,
} from "../../shared/dist/index.mjs";

import * as braintrust from "braintrust";

async function main() {
  const { all, passed, failed, xfail } = await runTests({
    name: "My Test Suite",
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

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### In Node.js (CJS)

```javascript
const {
  runTests,
  testBasicSpanLogging,
  testMultipleSpans,
} = require("../../shared");

const braintrust = require("braintrust");

async function main() {
  const { all, passed, failed, xfail } = await runTests({
    name: "Node.js CJS Tests",
    braintrust,
    tests: [testBasicSpanLogging, testMultipleSpans],
  });

  if (failed.length > 0) {
    process.exit(1);
  }
}
```

### In Node.js (ESM)

```typescript
import {
  runTests,
  testBasicSpanLogging,
  testMultipleSpans,
} from "../../shared";

import * as braintrust from "braintrust";

const { all, passed, failed, xfail } = await runTests({
  name: "Node.js ESM Tests",
  braintrust,
  tests: [testBasicSpanLogging, testMultipleSpans],
});

if (failed.length > 0) {
  process.exit(1);
}
```

### In Deno

```typescript
import {
  runTests,
  testBasicSpanLogging,
  testMultipleSpans,
} from "../../shared";

import * as braintrust from "braintrust";

const { all, passed, failed, xfail } = await runTests({
  name: "Deno Tests",
  braintrust,
  tests: [testBasicSpanLogging, testMultipleSpans],
});

if (failed.length > 0) {
  Deno.exit(1);
}
```

### In Cloudflare Workers

```typescript
import {
  runTests,
  expectFailure,
  testBasicSpanLogging,
  testNunjucksTemplate,
} from "../../../shared";

import * as braintrust from "braintrust";

export default {
  async fetch(request: Request): Promise<Response> {
    const { all, passed, failed, xfail } = await runTests({
      name: "Cloudflare Worker Tests",
      braintrust,
      tests: [
        testBasicSpanLogging,
        expectFailure(
          testNunjucksTemplate,
          (e) => e.message.includes("Disallowed"),
          "Cloudflare Workers blocks dynamic code generation",
        ),
      ],
    });

    return new Response(
      JSON.stringify({
        success: failed.length === 0,
        totalTests: all.length,
        passedTests: passed.length,
        failedTests: failed.length,
        xfailTests: xfail.length,
        results: all,
      }),
      {
        status: failed.length === 0 ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
};
```

## Core Concepts

### Test Registration Pattern

Tests are defined using the `register()` function which:

- Adds tests to a global registry for coverage validation
- Normalizes test output to `TestResult` format
- Handles setup/teardown automatically using `_exportsForTestingOnly`
- Wraps tests in try/catch blocks

```typescript
import { register } from "../helpers/register";

export const testMyFeature = register(
  "testMyFeature",
  async (braintrust, { backgroundLogger }) => {
    const initLogger = braintrust.initLogger as InitLoggerFn;
    const logger = initLogger({ projectName: "test-project" });

    // Test logic here

    return "Test passed successfully";
  },
);
```

### Test Runner: `runTests()`

The `runTests()` helper:

- Executes all provided tests
- Validates coverage (ensures all registered tests are called)
- Displays results automatically
- Returns structured results

**API:**

```typescript
interface RunTestsOptions {
  name: string; // Scenario name for display
  braintrust: BraintrustModule; // Braintrust SDK module
  tests: TestFn[]; // Array of test functions
}

interface TestRunResults {
  all: TestResult[]; // All test results
  passed: TestResult[]; // Only passed tests
  failed: TestResult[]; // Only failed tests
  xfail: TestResult[]; // Only expected failures
}

function runTests(options: RunTestsOptions): Promise<TestRunResults>;
```

**Example:**

```typescript
const { all, passed, failed, xfail } = await runTests({
  name: "My Test Suite",
  braintrust,
  tests: [testOne, testTwo, testThree],
});

// Access specific result categories
console.log(`Passed: ${passed.length}`);
console.log(`Failed: ${failed.length}`);
console.log(`Expected failures: ${xfail.length}`);
```

### Expected Failures: `expectFailure()`

Use `expectFailure()` to mark tests that are expected to fail in certain environments:

```typescript
expectFailure(
  testFunction, // The test function
  errorPredicate, // Function to validate the error
  reason, // Human-readable explanation
);
```

**Error Predicate:**
The `errorPredicate` function receives an error object and must return `true` if the error matches expectations:

```typescript
type ErrorPredicate = (error: { message: string; stack?: string }) => boolean;
```

**Examples:**

```typescript
// Simple message check
expectFailure(
  testNunjucksTemplate,
  (e) => e.message.includes("not supported"),
  "Nunjucks not supported in browser build",
);

// Multiple conditions
expectFailure(
  testAsyncLocalStorage,
  (e) =>
    e.message.includes("AsyncLocalStorage") ||
    e.message.includes("not available"),
  "ALS not available in this environment",
);

// Always expect failure (use sparingly)
expectFailure(
  testExperimentalFeature,
  () => true,
  "Feature not yet implemented",
);
```

**Why Error Predicates Matter:**

- Prevents masking unexpected errors
- Ensures the test fails for the expected reason
- If predicate returns `false`, the test remains a `fail` instead of converting to `xfail`

### Test Context

Tests receive a `TestContext` object with additional utilities:

```typescript
interface TestContext {
  backgroundLogger: BackgroundLogger; // Logger for capturing/draining logs
}
```

The `backgroundLogger` provides:

- `drain()` - Get and clear all captured events
- Access to logged events for verification

## Available Test Suites

### Import Verification

Tests that verify SDK exports are correctly exposed and not tree-shaken:

- `testCoreLoggingExports` - initLogger, Logger, Span, etc.
- `testDatasetExports` - Dataset class and methods
- `testPromptExports` - Prompt class and methods
- `testExperimentExports` - Experiment class and methods
- `testEvalExports` - Eval, Evaluator, Score, etc.
- `testTracingExports` - traced, startSpan, currentSpan, etc.
- `testClientWrapperExports` - wrapOpenAI, wrapAnthropic, etc.
- `testUtilityExports` - Utility functions
- `testFunctionExports` - Function class and methods
- `testFramework2Exports` - Framework exports
- `testIDGeneratorExports` - ID generation utilities
- `testTestingExports` - \_exportsForTestingOnly
- `testStateManagementExports` - State management utilities
- `testBuildResolution` - Verifies correct build (browser vs node) and format (cjs vs esm)

### Basic Logging

Tests core logging functionality:

- `testBasicSpanLogging` - Single span with input/output/expected
- `testMultipleSpans` - Multiple sequential spans
- `testDirectLogging` - Direct logger.log() if available
- `testJSONAttachment` - JSON attachment logging
- `testAsyncLocalStorageTraced` - ALS: traced() + startSpan() parent-child relationship
- `testNestedTraced` - ALS: Nested traced() calls (3-level hierarchy)
- `testCurrentSpan` - ALS: currentSpan() returns active span

**Async Local Storage (ALS) tests**: Verify parent-child span relationships work correctly.

- **Node.js/Deno**: Full ALS → verifies `span_parents` relationships
- **Browser/Workers**: May have limited or no ALS support
- **Edge**: May have ALS → tests check if relationships work

**Error handling**: Tests don't pre-check if functions exist. If `traced`, `startSpan`, or `currentSpan` are undefined, the code naturally throws and the error is caught by the `register()` wrapper, resulting in a test failure with the full stack trace.

### Prompt Templating

Tests prompt templating functionality:

- `testMustacheTemplate` - Mustache templating (works everywhere)
- `testNunjucksTemplate` - Nunjucks templating (Node.js only, uses eval/Function)

**Note**: Nunjucks tests typically fail in browser/Workers environments due to:

- Browser build doesn't include Nunjucks
- Cloudflare Workers blocks dynamic code generation (eval/Function)

Use `expectFailure()` for these tests in browser/Workers scenarios.

### Eval Smoke Test

Tests basic eval functionality:

- `testEvalSmoke` - Creates eval, runs test cases, verifies output structure

## Test Result Display

### Standardized Output Format

All scenarios use `displayTestResults()` for consistent output:

```typescript
import { displayTestResults } from "../../shared/dist/index.mjs";

// Called automatically by runTests(), but can also be used standalone
displayTestResults({
  scenarioName: "My Scenario Test Results",
  results: testResults,
  verbose: false, // Optional: show full stack traces
});
```

Output format:

```
=== My Scenario Test Results ===

Tests: 18/20 passed
Expected failures: 2

✓ testCoreLoggingExports
✓ testDatasetExports
✗ testFailingFeature
  Error: Feature not implemented
  at Feature.test (feature.ts:42:11)
⊘ testNunjucksTemplate
  Expected failure: Nunjucks not supported in browser build
```

### Display Utilities

- `displayTestResults(options)` - Display results in standardized format
- `hasFailures(results)` - Check if there are any real failures (excluding xfail)
- `getFailureCount(results)` - Get count of real failures
- `getTestStats(results)` - Get summary statistics (total, passed, failed, xfail)

## Adding New Tests

1. **Create test function in a suite file:**

```typescript
// src/suites/my-suite.ts
import { register } from "../helpers/register";

export const testMyFeature = register(
  "testMyFeature",
  async (braintrust, { backgroundLogger }) => {
    const MyClass = braintrust.MyClass as typeof MyClassType;

    const instance = new MyClass();
    const result = await instance.doSomething();

    assertEqual(result, expectedValue);

    return "Test passed successfully";
  },
);
```

2. **Export from `src/index.ts`:**

```typescript
export { testMyFeature } from "./suites/my-suite";
```

3. **Rebuild:**

```bash
npm run build
```

4. **Use in scenarios:**

```typescript
import { runTests, testMyFeature } from "../../shared";

const { failed } = await runTests({
  name: "My Scenario",
  braintrust,
  tests: [testMyFeature],
});
```

## Best Practices

### Write Environment-Agnostic Tests

Let tests fail naturally when features aren't available:

```typescript
// ✓ Good - let it throw naturally
export const testDatasets = register("testDatasets", async (braintrust) => {
  const Dataset = braintrust.Dataset as typeof DatasetClass;
  const dataset = new Dataset();
  // ... test logic
});

// In scenarios where Dataset isn't available, wrap with expectFailure:
expectFailure(
  testDatasets,
  (e) => e.message.includes("Dataset is not defined"),
  "Datasets not available in browser build",
);
```

### Use Provided Assertions

Use the provided assertion helpers instead of environment-specific ones:

```typescript
import { assert, assertEqual, assertNotEmpty } from "../helpers/assertions";

// ✓ Good - works everywhere
assertEqual(actual, expected);

// ✗ Bad - only works in specific environments
expect(actual).toBe(expected); // Jest-specific
assertEquals(actual, expected); // Deno-specific
```

### Return Success Messages

Test functions should return a descriptive success message:

```typescript
export const testMyFeature = register("testMyFeature", async (braintrust) => {
  // ... test logic

  return "MyFeature works correctly with X and Y";
});
```

### Type Assertions

Since `BraintrustModule` properties are typed as `unknown`, explicitly cast them:

```typescript
export const testSomething = register("testSomething", async (braintrust) => {
  const initLogger = braintrust.initLogger as InitLoggerFn;
  const MyClass = braintrust.MyClass as typeof MyClassType;

  // Now use with proper types
  const logger = initLogger({ projectName: "test" });
  const instance = new MyClass();
});
```

## Development Workflow

1. Make changes to test suites in `src/`
2. Run `npm run build` to rebuild
3. Test in a target smoke scenario:
   ```bash
   cd ../scenarios/<scenario-name>
   make test
   ```
4. Verify tests pass in multiple environments

## Coverage Validation

The test framework automatically validates that all registered tests are run in each scenario. If a scenario forgets to include a test, `validateCoverage()` (called automatically by `runTests()`) will add a failure to the results:

```
✗ Test coverage validation
  Missing tests: testForgottenTest, testAnotherMissing
```

This ensures scenarios don't accidentally skip tests.

## Notes

- Tests use `_exportsForTestingOnly` to avoid hitting real APIs
- Each test suite is independent and idempotent
- The `register()` wrapper handles setup/cleanup automatically
- The package is marked `private: true` - it's only for internal smoke tests
- No manual `try/catch` blocks needed - `register()` handles this
- No manual coverage validation needed - `runTests()` handles this
