type BraintrustModule = Record<string, unknown>;

function assert(
  condition: unknown,
  message: string,
): asserts condition is true {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getTestRunId(): string {
  const testRunId = Deno.env.get("BRAINTRUST_E2E_RUN_ID");
  assert(testRunId, "BRAINTRUST_E2E_RUN_ID must be set");
  return testRunId;
}

export function scopedName(base: string): string {
  return `${base}-${getTestRunId()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")}`;
}

export function expectNamedExports(
  module: BraintrustModule,
  exportNames: string[],
): void {
  for (const exportName of exportNames) {
    assert(module[exportName], `Expected export "${exportName}" to exist`);
  }
}

export function expectBuildType(
  module: BraintrustModule,
  expectedBuildType: string,
): void {
  const testingOnly = module._exportsForTestingOnly;
  assert(isRecord(testingOnly), "_exportsForTestingOnly must exist");

  const isomorph = testingOnly.isomorph;
  assert(isRecord(isomorph), "_exportsForTestingOnly.isomorph must exist");
  assert(
    isomorph.buildType === expectedBuildType,
    `Expected build type "${expectedBuildType}" but got "${String(isomorph.buildType)}"`,
  );
}

export function expectMustacheTemplate(module: BraintrustModule): void {
  const Prompt = module.Prompt as
    | (new (...args: unknown[]) => {
        build: (
          args: Record<string, unknown>,
          options: { templateFormat: string },
        ) => { messages?: Array<{ content?: string }> };
      })
    | undefined;

  assert(Prompt, "Prompt export must exist");

  const prompt = new Prompt(
    {
      name: "mustache-test",
      slug: "mustache-test",
      prompt_data: {
        prompt: {
          type: "chat",
          messages: [{ role: "user", content: "Hello, {{name}}!" }],
        },
        options: { model: "gpt-4" },
      },
    },
    {},
    false,
  );

  const result = prompt.build(
    { name: "World" },
    { templateFormat: "mustache" },
  );
  assert(
    result.messages?.[0]?.content === "Hello, World!",
    "Mustache template rendering failed",
  );
}

export function expectNunjucksTemplateUnavailable(
  module: BraintrustModule,
): void {
  const Prompt = module.Prompt as
    | (new (...args: unknown[]) => {
        build: (
          args: Record<string, unknown>,
          options: { templateFormat: string },
        ) => unknown;
      })
    | undefined;

  assert(Prompt, "Prompt export must exist");

  const prompt = new Prompt(
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
        options: { model: "gpt-4" },
      },
    },
    {},
    false,
  );

  let errorMessage: string | undefined;
  try {
    prompt.build(
      {
        items: [{ name: "apple" }, { name: "banana" }, { name: "cherry" }],
      },
      { templateFormat: "nunjucks" },
    );
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  assert(
    errorMessage?.includes("requires @braintrust/template-nunjucks"),
    `Expected missing nunjucks package error, got: ${errorMessage ?? "no error"}`,
  );
}

export async function expectEvalWorks(module: BraintrustModule): Promise<void> {
  const Eval = module.Eval as
    | ((
        name: string,
        definition: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>)
    | undefined;

  assert(Eval, "Eval export must exist");

  const evalData = [
    { input: "Alice", expected: "Hi Alice" },
    { input: "Bob", expected: "Hi Bob" },
    { input: "Charlie", expected: "Hi Charlie" },
  ];

  const result = await Eval(
    "deno-local-eval",
    {
      data: evalData,
      task: async (input: string) => `Hi ${input}`,
      scores: [
        ({ expected, output }: { expected: string; output: string }) => ({
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

  const summary = result.summary;
  const results = result.results;
  assert(Array.isArray(results), "Eval results must be an array");
  assert(
    results.length === evalData.length,
    "Eval returned the wrong row count",
  );
  assert(isRecord(summary), "Eval summary must exist");
  assert(isRecord(summary.scores), "Eval summary scores must exist");

  const exactMatch = summary.scores.exact_match;
  assert(isRecord(exactMatch), "Eval exact_match summary must exist");
  assert(exactMatch.score === 1, "Eval exact_match summary must be 1");
}
