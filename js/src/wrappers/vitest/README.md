# Braintrust Vitest Integration

The Braintrust Vitest wrapper provides automatic experiment tracking, dataset management, and evaluation scoring for your Vitest tests. It seamlessly integrates Braintrust's evaluation framework into your testing workflow.

## Quick Start

```typescript
import { test, expect, describe, afterAll } from "vitest";
import { wrapVitest } from "braintrust";

const bt = wrapVitest(
  { test, expect, describe, afterAll },
  { projectName: "my-project" },
);

bt.describe("Translation Tests", () => {
  bt.test(
    "translates hello",
    {
      input: { text: "hello" },
      expected: "hola",
      metadata: { language: "spanish" },
    },
    async ({ input, expected }) => {
      const result = await translate(input.text);
      bt.logOutputs({ translation: result });
      expect(result).toBe(expected);
    },
  );

  bt.afterAll(async () => {
    await bt.flushExperiment();
  });
});
```

## Core Features

- Experiment Tracking, each `describe()` block creates a Braintrust experiment
- Test pass/fail rates automatically logged
- Automatic scoring with scorers
- use existing braintrust datasets for tests

---

## Using Scorers

Scorers automatically evaluate your test outputs and log scores to Braintrust.

### Basic Scorer Usage

```typescript
bt.test(
  "translation quality",
  {
    input: { text: "hello world" },
    expected: "hola mundo",
    scorers: [
      // Custom scorer function
      ({ output, expected }) => ({
        name: "exact_match",
        score: output === expected ? 1 : 0,
      }),
    ],
  },
  async ({ input }) => {
    const result = await translate(input.text);
    return result; // Return value is passed to scorers as "output"
  },
);
```

**Key Points:**

- Scorers receive `{ output, expected, input, metadata }`
- Test function **must return a value** for scorers to evaluate
- Scorers run automatically after test completes (even if test fails)

### Using Built-in Scorers

Import scorers from the `autoevals` package for common evaluation tasks:

```typescript
import { Levenshtein, Factuality, EmbeddingSimilarity } from "autoevals";

bt.test(
  "LLM output quality",
  {
    input: { prompt: "Explain 1 + 1" },
    expected: "2",
    scorers: [Factuality, Levenshtein, EmbeddingSimilarity],
  },
  async ({ input }) => {
    const response = await llm.generate(input.prompt);
    return response;
  },
);
```

### Custom Scorers

Create your own scorer functions for domain-specific evaluation:

```typescript
const lengthScorer = ({ output }) => ({
  name: "appropriate_length",
  score: output.length >= 50 && output.length <= 200 ? 1 : 0.5,
  metadata: { actual_length: output.length },
});

const customScorer = async ({ output, expected, input }) => {
  const similarity = await calculateSimilarity(output, expected);
  return {
    name: "custom_similarity",
    score: similarity,
    metadata: {
      input_tokens: input.text.split(" ").length,
      output_tokens: output.split(" ").length,
    },
  };
};

bt.test(
  "test with custom scorers",
  {
    input: { text: "Write a summary" },
    expected: "This is a good summary",
    scorers: [lengthScorer, customScorer],
  },
  async ({ input }) => {
    return await generateSummary(input.text);
  },
);
```

### Multiple Scorers

Run multiple scorers to evaluate different aspects of output:

```typescript
bt.test(
  "comprehensive evaluation",
  {
    input: { prompt: "Write a poem" },
    expected: { hasRhyme: true, sentiment: "positive" },
    scorers: [
      ({ output }) => ({
        name: "has_rhyme",
        score: detectRhyme(output) ? 1 : 0,
      }),
      ({ output }) => ({
        name: "positive_sentiment",
        score: analyzeSentiment(output) === "positive" ? 1 : 0,
      }),
      ({ output }) => ({
        name: "appropriate_length",
        score: output.split("\n").length >= 4 ? 1 : 0.5,
      }),
    ],
  },
  async ({ input }) => {
    return await generatePoem(input.prompt);
  },
);
```

---

## Working with Datasets

Datasets let you run the same test logic across multiple input/expected pairs. You can define data inline or load from existing Braintrust datasets.

### Option 1: Inline Data

Define test cases directly in your test configuration:

```typescript
bt.test(
  "translation test",
  {
    data: [
      { input: { text: "hello" }, expected: "hola" },
      { input: { text: "goodbye" }, expected: "adiós" },
      { input: { text: "thank you" }, expected: "gracias" },
    ],
    scorers: [Levenshtein], // Optional: add scorers
  },
  async ({ input, expected }) => {
    const result = await translate(input.text);
    return result;
  },
);
```

**What happens:**

- Creates **3 separate tests** (one per data record)
- Each test named: `"translation test [0]"`, `"translation test [1]"`, etc.
- Each test receives its own `input` and `expected` values
- Scorers run on each test automatically

### Option 2: Load from Braintrust Dataset

Fetch test cases from an existing Braintrust dataset.

```typescript
import { initDataset } from "braintrust";

// Load dataset at test registration time
const testData = await initDataset({
  project: "my-project",
  dataset: "translations-v1",
  version: "latest", // optional: specify version
}).fetchedData();

bt.describe("Translation Suite", () => {
  // Use loaded data with the data field
  bt.test(
    "translation test",
    {
      data: testData, // Available at registration time
      scorers: [Levenshtein, Factuality],
    },
    async ({ input, expected }) => {
      const result = await translate(input.text);
      return result;
    },
  );

  bt.afterAll(async () => {
    await bt.flushExperiment();
  });
});
```

**Dataset Options:**

```typescript
import { initDataset } from "braintrust";

initDataset({
  project: "my-project", // Project name or ID
  dataset: "my-dataset", // Dataset name or ID
  version: "v1.2", // Optional: specific version
  description: "...", // Optional: description
}).fetchedData();
```

### Combining Datasets with Scorers

The most powerful pattern combines datasets with automatic scoring:

```typescript
import { initDataset } from "braintrust";

bt.describe("LLM Evaluation Suite", () => {
  const evalData = initDataset({
    project: "llm-evals",
    dataset: "qa-benchmark",
  }).fetchedData();

  bt.test.each(await evalData)(
    "Q&A evaluation",
    {
      scorers: [
        Factuality,
        ({ output, expected }) => ({
          name: "conciseness",
          score: output.length <= expected.length * 1.2 ? 1 : 0.7,
        }),
      ],
    },
    async (record) => {
      const { input, expected } = record;
      const answer = await llm.answer(input.question);
      return answer;
    },
  );

  bt.afterAll(async () => {
    await bt.flushExperiment();
  });
});
```

**Benefits:**

- Centralized test data in Braintrust
- Version control for datasets
- Automatic scoring across all examples
- Easy comparison across experiment runs
- Reuse datasets across different test suites

---

## API Reference

### wrapVitest(vitestMethods, config)

Wraps Vitest will wrap Vitest methods with Braintrust experiment tracking.

**Parameters:**

```typescript
wrapVitest(
  vitestMethods: {
    test: TestFunction;
    expect: any;
    describe: DescribeFunction;
    afterAll?: (fn: () => void | Promise<void>) => void;
    beforeAll?: (fn: () => void | Promise<void>) => void;
    beforeEach?: (fn: (context: any) => void | Promise<void>) => void;
    afterEach?: (fn: (context: any) => void | Promise<void>) => void;
  },
  config?: {
    projectName?: string;        // Project name (defaults to suite name)
    projectId?: string;          // Stable project ID; takes precedence over projectName
    displaySummary?: boolean;    // Show summary after tests (default: true)
    onProgress?: (event: ProgressEvent) => void;  // Progress callback
  }
)
```

### Test Configuration

Enhanced test signature with full options:

```typescript
bt.test(
  "test name",
  {
    // Test data
    input?: any,              // Test input
    expected?: any,           // Expected output
    metadata?: object,        // Custom metadata
    tags?: string[],          // Organization tags

    // Scorers
    scorers?: ScorerFunction[],  // Array of scorer functions

    // Inline data
    data?: Array<{
      input?: any;
      expected?: any;
      metadata?: object;
      tags?: string[];
    }>,

    // Vitest options that will be passed through
    timeout?: number,
    retry?: number,
    // ... any other vitest options
  },
  async ({ input, expected, metadata }) => {
    // Test implementation
    const result = await yourFunction(input);
    return result;
  }
);
```

### Logging Functions

#### logOutputs(outputs)

Log custom outputs to the current test span:

```typescript
bt.logOutputs({
  translation: result,
  confidence: 0.95,
  model: "gpt-4",
});
```

#### logFeedback(feedback)

Log custom scores/metrics to the current test span:

```typescript
bt.logFeedback({
  name: "custom_metric",
  score: 0.85,
  metadata: { reasoning: "..." },
});
```

---

## Advanced Usage

### Progress Monitoring

Monitor test progress in real-time:

```typescript
const bt = wrapVitest(
  { test, expect, describe, afterAll },
  {
    projectName: "my-project",
    onProgress: (event) => {
      if (event.type === "test_complete") {
        console.log(
          `✓ ${event.testName}: ${event.passed ? "PASS" : "FAIL"} (${event.duration}ms)`,
        );
      }
    },
  },
);
```

---

## Examples

### Simple Scorer Evaluation

```typescript
import { test, expect, describe, afterAll } from "vitest";
import { wrapVitest } from "braintrust";
import { Levenshtein } from "autoevals";

const bt = wrapVitest(
  { test, expect, describe, afterAll },
  { projectName: "translation-eval" },
);

bt.describe("Translation Quality", () => {
  bt.test(
    "translates accurately",
    {
      input: { text: "hello world", lang: "es" },
      expected: "hola mundo",
      scorers: [
        Levenshtein,
        ({ output, expected }) => ({
          name: "exact_match",
          score: output.toLowerCase() === expected.toLowerCase() ? 1 : 0,
        }),
      ],
    },
    async ({ input, expected }) => {
      const result = await translate(input.text, input.lang);
      return result;
    },
  );
});
```

### Dataset with Multiple Scorers

```typescript
import { test, expect, describe, afterAll } from "vitest";
import { wrapVitest } from "braintrust";
import { Factuality, EmbeddingSimilarity } from "autoevals";

const bt = wrapVitest(
  { test, expect, describe, afterAll },
  { projectName: "llm-qa-eval" },
);

bt.describe("LLM Q&A Evaluation", () => {
  const qaData = initDataset({
    project: "qa-benchmarks",
    dataset: "science-questions",
  }).fetchedData();

  bt.test.each(await qaData)(
    "answer quality",
    {
      scorers: [
        Factuality,
        EmbeddingSimilarity,
        ({ output }) => ({
          name: "no_hallucination",
          score: !containsHallucination(output) ? 1 : 0,
        }),
      ],
    },
    async (record) => {
      const { input, expected } = record;
      const answer = await llm.answer(input.question);
      return answer;
    },
  );
});
```

### Inline Data with Custom Scorers

```typescript
import { test, expect, describe, afterAll } from "vitest";
import { wrapVitest } from "braintrust";

const bt = wrapVitest(
  { test, expect, describe, afterAll },
  { projectName: "sentiment-analysis" },
);

bt.describe("Sentiment Analysis Tests", () => {
  bt.test(
    "classifies sentiment correctly",
    {
      data: [
        { input: { text: "I love this!" }, expected: "positive" },
        { input: { text: "This is terrible" }, expected: "negative" },
        { input: { text: "It's okay" }, expected: "neutral" },
        { input: { text: "Amazing experience!" }, expected: "positive" },
      ],
      scorers: [
        ({ output, expected }) => ({
          name: "accuracy",
          score: output === expected ? 1 : 0,
        }),
        ({ output, input }) => ({
          name: "confidence",
          score: getSentimentConfidence(output, input.text),
        }),
      ],
    },
    async ({ input }) => {
      const sentiment = await analyzeSentiment(input.text);
      return sentiment;
    },
  );
});
```

---

## TypeScript Types

All types are exported for your convenience:

```typescript
import type {
  TestConfig,
  TestContext,
  Score,
  ScorerFunction,
  DatasetOptions,
  DatasetRecord,
  BraintrustVitest,
  WrapperConfig,
} from "braintrust";

// Define a custom scorer with types
const myScorer: ScorerFunction = ({ output, expected, input, metadata }) => {
  return {
    name: "my_scorer",
    score: calculateScore(output, expected),
    metadata: { input_length: JSON.stringify(input).length },
  };
};
```

---

## Additional Resources

- [Braintrust Documentation](https://www.braintrust.dev/docs)
- [Autoevals Library](https://www.braintrust.dev/docs/autoevals)
- [Vitest Documentation](https://vitest.dev/)
