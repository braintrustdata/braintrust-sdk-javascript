const {
  Eval,
  JSONAttachment,
  Prompt,
  _exportsForTestingOnly,
  currentSpan,
  initLogger,
  startSpan,
  traced,
} = require("braintrust");

const testRunId = process.env.BRAINTRUST_E2E_RUN_ID;
const scenario = "test-framework-evals-jest";

function scopedName(base) {
  return `${base}-${testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function createLogger() {
  return initLogger({
    projectName: scopedName("e2e-test-framework-evals-jest"),
  });
}

function expectNamedExports(module, exportNames) {
  for (const exportName of exportNames) {
    expect(module[exportName]).toBeDefined();
  }
}

test("jest exposes the core braintrust runtime surface in CommonJS", () => {
  const braintrust = require("braintrust");

  expectNamedExports(braintrust, [
    "initLogger",
    "currentSpan",
    "startSpan",
    "log",
    "flush",
    "initDataset",
    "initExperiment",
    "loadPrompt",
    "Prompt",
    "Eval",
    "traced",
    "wrapOpenAI",
    "JSONAttachment",
    "Attachment",
    "invoke",
    "initFunction",
    "Project",
    "PromptBuilder",
    "IDGenerator",
    "BraintrustState",
    "login",
    "_exportsForTestingOnly",
  ]);
});

test("jest resolves the node build in CommonJS mode", () => {
  expect(_exportsForTestingOnly).toBeDefined();
  expect(_exportsForTestingOnly.isomorph.buildType).toBe("node");
});

test("jest renders mustache prompts and fails clearly for nunjucks without the extra package", () => {
  const mustachePrompt = new Prompt(
    {
      name: "mustache-test",
      slug: "mustache-test",
      prompt_data: {
        prompt: {
          type: "chat",
          messages: [
            {
              role: "user",
              content: "Hello, {{name}}!",
            },
          ],
        },
        options: {
          model: "gpt-4",
        },
      },
    },
    {},
    false,
  );

  const mustacheResult = mustachePrompt.build(
    { name: "World" },
    { templateFormat: "mustache" },
  );
  expect(mustacheResult.messages[0]?.content).toBe("Hello, World!");

  const nunjucksPrompt = new Prompt(
    {
      name: "nunjucks-test",
      slug: "nunjucks-test",
      prompt_data: {
        prompt: {
          type: "chat",
          messages: [
            {
              role: "user",
              content:
                "Items: {% for item in items %}{{ item.name }}{% if not loop.last %}, {% endif %}{% endfor %}",
            },
          ],
        },
        options: {
          model: "gpt-4",
        },
      },
    },
    {},
    false,
  );

  expect(() =>
    nunjucksPrompt.build(
      {
        items: [{ name: "apple" }, { name: "banana" }, { name: "cherry" }],
      },
      { templateFormat: "nunjucks" },
    ),
  ).toThrow(/requires @braintrust\/template-nunjucks/);
});

test("jest can run Eval locally without sending logs", async () => {
  const result = await Eval(
    "jest-local-eval",
    {
      data: [
        { input: "Alice", expected: "Hi Alice" },
        { input: "Bob", expected: "Hi Bob" },
        { input: "Charlie", expected: "Hi Charlie" },
      ],
      task: async (input) => `Hi ${input}`,
      scores: [
        ({ expected, output }) => ({
          name: "exact_match",
          score: output === expected ? 1 : 0,
        }),
      ],
    },
    {
      noSendLogs: true,
      returnResults: true,
    },
  );

  expect(result.results).toHaveLength(3);
  expect(result.summary.scores.exact_match.score).toBe(1);
  for (const row of result.results) {
    expect(row.output).toBe(row.expected);
    expect(row.scores.exact_match).toBe(1);
  }
});

test("jest logs a manual span via the node transport", async () => {
  const logger = createLogger();
  const span = logger.startSpan({
    name: "jest basic span",
    event: {
      metadata: {
        case: "basic-span",
        scenario,
        testRunId,
      },
    },
  });

  span.log({
    expected: "Paris",
    input: "What is the capital of France?",
    metadata: {
      case: "basic-span",
      scenario,
      testRunId,
      transport: "http",
    },
    output: "Paris",
  });
  span.end();

  await logger.flush();
});

test("jest supports direct logging with JSON attachments", async () => {
  const logger = createLogger();
  const testData = {
    foo: "bar",
    nested: {
      array: [1, 2, 3],
      bool: true,
    },
  };

  logger.log({
    input: {
      transcript: new JSONAttachment(testData, {
        filename: "conversation_transcript.json",
        pretty: true,
      }),
      type: "chat_completion",
    },
    metadata: {
      case: "json-attachment",
      scenario,
      testRunId,
    },
    output: {
      attachment: true,
    },
  });

  expect(testData.nested.array).toEqual([1, 2, 3]);
  await logger.flush();
});

test("jest preserves traced parent-child relationships", async () => {
  const logger = createLogger();

  await traced(
    async (parentSpan) => {
      await new Promise((resolve) => setTimeout(resolve, 10));

      const childSpan = startSpan({
        name: "jest child span",
        event: {
          input: {
            step: "child",
            testRunId,
          },
          metadata: {
            case: "child-span",
            scenario,
            testRunId,
          },
        },
      });

      childSpan.log({
        output: {
          phase: "child",
          ok: true,
        },
      });
      childSpan.end();

      parentSpan.log({
        output: {
          phase: "parent",
          ok: true,
        },
      });
    },
    {
      name: "jest parent span",
      event: {
        input: {
          phase: "parent",
          testRunId,
        },
        metadata: {
          case: "parent-span",
          scenario,
          testRunId,
        },
      },
    },
  );

  await logger.flush();
});

test("jest preserves nested traced ancestry", async () => {
  const logger = createLogger();

  await traced(
    async () => {
      await traced(
        async () => {
          await traced(
            async () => {
              currentSpan().log({
                metadata: {
                  case: "nested-grandchild",
                  scenario,
                  testRunId,
                },
                output: {
                  depth: 3,
                },
              });
            },
            {
              name: "jest nested grandchild span",
              event: {
                metadata: {
                  case: "nested-grandchild",
                  scenario,
                  testRunId,
                },
              },
            },
          );
        },
        {
          name: "jest nested child span",
          event: {
            metadata: {
              case: "nested-child",
              scenario,
              testRunId,
            },
          },
        },
      );
    },
    {
      name: "jest nested parent span",
      event: {
        metadata: {
          case: "nested-parent",
          scenario,
          testRunId,
        },
      },
    },
  );

  await logger.flush();
});

test("jest exposes currentSpan inside traced callbacks", async () => {
  const logger = createLogger();

  await traced(
    async () => {
      const activeSpan = currentSpan();
      expect(activeSpan).toBeDefined();

      activeSpan.log({
        metadata: {
          case: "current-span",
          scenario,
          testRunId,
        },
        output: {
          observedSpanId: activeSpan.spanId,
        },
      });
    },
    {
      name: "jest current span",
      event: {
        metadata: {
          case: "current-span",
          scenario,
          testRunId,
        },
      },
    },
  );

  await logger.flush();
});
