# Braintrust Node.js Test Runner Integration

The Braintrust Node.js test runner integration provides automatic experiment tracking for tests written with `node:test`. It works alongside the native `test()` and `describe()` functions — no wrapping or replacing needed.

## Quick Start

```typescript
import { test, describe, after } from "node:test";
import { initNodeTestSuite } from "braintrust";

describe("My Evaluation Suite", () => {
  const suite = initNodeTestSuite({
    projectName: "my-project",
    after, // Auto-flush when tests complete
  });

  test(
    "evaluates output",
    suite.eval(
      {
        input: { text: "hello" },
        expected: "hola",
      },
      async ({ input }) => {
        const result = await translate(input.text);
        return result; // Return value is logged as output
      },
    ),
  );

  // Untracked tests work normally — no Braintrust involvement
  test("sanity check", () => {
    assert.strictEqual(1 + 1, 2);
  });
});
```

## Core Features

- **Composable** — `suite.eval()` returns a standard test function, works alongside native `test()`/`describe()`
- **Experiment tracking** — Each suite creates a Braintrust experiment with automatic pass/fail scoring
- **Automatic scoring** — Add scorer functions to evaluate outputs
- **Data expansion** — Use standard JS loops for parameterized tests
- **Auto-flush** — Pass `after` from `node:test` to flush automatically

## Using Scorers

Scorers automatically evaluate your test outputs and log scores to Braintrust.

### Basic Scorer Usage

```typescript
test(
  "translation quality",
  suite.eval(
    {
      input: { text: "hello world" },
      expected: "hola mundo",
      scorers: [
        ({ output, expected }) => ({
          name: "exact_match",
          score: output === expected ? 1 : 0,
        }),
      ],
    },
    async ({ input }) => {
      return await translate(input.text);
    },
  ),
);
```

**Key Points:**

- Scorers receive `{ output, expected, input, metadata }`
- Test function **must return a value** for scorers to evaluate
- Scorers run automatically after test completes (even if test fails)

### Using Built-in Scorers

Import scorers from the `autoevals` package:

```typescript
import { Levenshtein, Factuality } from "autoevals";

test(
  "LLM output quality",
  suite.eval(
    {
      input: { prompt: "Explain 1 + 1" },
      expected: "2",
      scorers: [Factuality, Levenshtein],
    },
    async ({ input }) => {
      return await llm.generate(input.prompt);
    },
  ),
);
```

### Custom Scorers

```typescript
const lengthScorer = ({ output }) => ({
  name: "appropriate_length",
  score: output.length >= 50 && output.length <= 200 ? 1 : 0.5,
  metadata: { actual_length: output.length },
});
```

## Working with Datasets

### Inline Data Expansion

Use standard JavaScript loops to expand test cases:

```typescript
const data = [
  { input: { text: "hello" }, expected: "hola" },
  { input: { text: "goodbye" }, expected: "adiós" },
  { input: { text: "thank you" }, expected: "gracias" },
];

for (const [i, record] of data.entries()) {
  test(
    `translation [${i}]`,
    suite.eval(
      {
        ...record,
        scorers: [Levenshtein],
      },
      async ({ input }) => {
        return await translate(input.text);
      },
    ),
  );
}
```

### Loading from Braintrust Datasets

```typescript
import { initDataset } from "braintrust";

const dataset = await initDataset({
  project: "my-project",
  dataset: "translations-v1",
}).fetchedData();

for (const [i, record] of dataset.entries()) {
  test(
    `translation [${i}]`,
    suite.eval(
      {
        input: record.input,
        expected: record.expected,
        scorers: [Levenshtein],
      },
      async ({ input }) => {
        return await translate(input.text);
      },
    ),
  );
}
```

## Custom Logging with `currentSpan()`

For custom outputs, scores, or metadata beyond what scorers provide, use `currentSpan()` from the main Braintrust API directly inside your `suite.eval()` callback:

```typescript
import { currentSpan } from "braintrust";

test(
  "translates with confidence",
  suite.eval(
    {
      input: { text: "goodbye" },
      expected: "adiós",
    },
    async ({ input }) => {
      const result = await translateWithConfidence(input.text);

      currentSpan().log({
        output: { confidence: result.confidence },
        scores: { high_confidence: result.confidence > 0.9 ? 1 : 0 },
        metadata: { model: "gpt-4" },
      });

      return result.text;
    },
  ),
);
```

## API Reference

### `initNodeTestSuite(config)`

Creates a new test suite with Braintrust experiment tracking.

**Parameters:**

```typescript
initNodeTestSuite({
  projectName: string;           // Required: Braintrust project name
  experimentName?: string;       // Optional: custom experiment name
  displaySummary?: boolean;      // Show summary after flush (default: true)
  after?: (fn: () => void | Promise<void>) => void;  // Auto-flush hook
  onProgress?: (event: ProgressEvent) => void;        // Progress callback
})
```

**Returns:** `NodeTestSuite` with `eval()` and `flush()` methods.

### `suite.eval(config, fn)`

Creates a test function compatible with `node:test`.

**Parameters:**

```typescript
suite.eval(
  {
    input?: any;                    // Test input
    expected?: any;                 // Expected output
    metadata?: Record<string, unknown>;  // Custom metadata
    tags?: string[];                // Organization tags
    scorers?: ScorerFunction[];     // Scorer functions
    name?: string;                  // Override span name
  },
  async ({ input, expected, metadata }) => {
    // Test implementation — return value becomes output
    return result;
  },
);
```

**Returns:** `(t: TestContext) => Promise<void>` — pass this to `test()` from `node:test`.

### `suite.flush()`

Summarize and flush the experiment to Braintrust. Called automatically if `after` was provided.

```typescript
// Manual flush
after(async () => {
  await suite.flush();
});
```

## Examples

### Complete Example

```typescript
import { test, describe, after } from "node:test";
import { initNodeTestSuite, currentSpan } from "braintrust";
import { Levenshtein } from "autoevals";

describe("Translation Evaluation", () => {
  const suite = initNodeTestSuite({
    projectName: "translations",
    after,
  });

  // Simple test
  test(
    "translates hello",
    suite.eval(
      {
        input: { text: "hello" },
        expected: "hola",
        scorers: [Levenshtein],
      },
      async ({ input }) => {
        return await translate(input.text);
      },
    ),
  );

  // Test with custom span logging
  test(
    "translates with confidence",
    suite.eval(
      {
        input: { text: "goodbye" },
        expected: "adiós",
      },
      async ({ input }) => {
        const result = await translateWithConfidence(input.text);
        currentSpan().log({
          output: { confidence: result.confidence },
          scores: { high_confidence: result.confidence > 0.9 ? 1 : 0 },
        });
        return result.text;
      },
    ),
  );

  // Data expansion
  const cases = [
    { input: { text: "yes" }, expected: "sí" },
    { input: { text: "no" }, expected: "no" },
  ];

  for (const [i, c] of cases.entries()) {
    test(
      `batch [${i}]`,
      suite.eval(c, async ({ input }) => {
        return await translate(input.text);
      }),
    );
  }
});
```

## Additional Resources

- [Braintrust Documentation](https://docs.braintrust.dev)
- [Autoevals Library](https://docs.braintrust.dev/sdks/typescript/related/autoevals/overview)
- [Node.js Test Runner Documentation](https://nodejs.org/api/test.html)
