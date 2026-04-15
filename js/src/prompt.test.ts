import { beforeAll, describe, test, expect, expectTypeOf, vi } from "vitest";
import { configureNode } from "./node/config";
import { type CompiledPrompt, Prompt } from "./logger";
import { type PromptDataType as PromptData } from "./generated_types";

describe("prompt strict mode", () => {
  test("strict mode", () => {
    for (const strict of [true, false]) {
      for (const shouldFail of [true, false]) {
        for (const testNull of [true, false]) {
          testPromptBuild({
            promptData: {
              options: {
                model: "gpt-4o",
              },
              prompt: {
                type: "chat",
                messages: [{ role: "user", content: "{{variable}}" }],
              },
            },
            args: shouldFail
              ? {}
              : testNull
                ? { variable: null }
                : {
                    variable: "test",
                  },
            shouldFail,
            strict,
          });

          testPromptBuild({
            promptData: {
              options: {
                model: "gpt-4o",
              },
              prompt: {
                type: "chat",
                messages: [{ role: "user", content: "What is 1+1" }],
                tools: JSON.stringify([
                  {
                    type: "function",
                    function: {
                      name: "{{variable}}",
                      description: "Add two numbers",
                      parameters: {
                        type: "object",
                        properties: {
                          a: { type: "number" },
                          b: { type: "number" },
                        },
                        required: ["a", "b"],
                      },
                    },
                  },
                ]),
              },
            },
            args: shouldFail
              ? {}
              : testNull
                ? { variable: null }
                : {
                    variable: "test",
                  },
            shouldFail,
            strict,
          });

          testPromptBuild({
            promptData: {
              options: {
                model: "gpt-4o",
              },
              prompt: {
                type: "completion",
                content: "{{variable}}",
              },
            },
            args: shouldFail
              ? {}
              : testNull
                ? { variable: null }
                : {
                    variable: "test",
                  },
            shouldFail,
            strict,
          });
        }
      }
    }
  });
});

function testPromptBuild({
  promptData,
  args,
  shouldFail,
  strict,
}: {
  promptData: PromptData;
  args: Record<string, unknown>;
  shouldFail: boolean;
  strict: boolean;
}) {
  const prompt = new Prompt(
    {
      id: "1",
      _xact_id: "xact_123",
      created: "2023-10-01T00:00:00Z",
      project_id: "project_123",
      prompt_session_id: "session_123",
      name: "test",
      slug: "test",
      prompt_data: promptData,
    },
    {},
    true,
  );

  try {
    prompt.build(args, { flavor: promptData.prompt?.type, strict });
  } catch (e) {
    if (!strict || !shouldFail) {
      throw e;
    }
    return;
  }

  if (shouldFail && strict) {
    throw new Error("Expected prompt to fail");
  }
}

describe("prompt template_format", () => {
  beforeAll(() => {
    configureNode();
  });

  test("uses template_format when building", () => {
    const prompt = new Prompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          template_format: "nunjucks",
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "Hello {% if name %}{{name}}{% endif %}",
              },
            ],
          },
        },
      },
      {},
      true,
    );

    expect(() => prompt.build({ name: "World" })).toThrow(
      "Nunjucks templating requires @braintrust/template-nunjucks. Install and import it to enable templateFormat: 'nunjucks'.",
    );
  });

  test("defaults to mustache when no templateFormat specified", () => {
    const prompt = new Prompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "chat",
            messages: [{ role: "user", content: "Hello {{name}}" }],
          },
        },
      },
      {},
      true,
    );

    const result = prompt.build({ name: "World" });
    expect(result.messages[0].content).toBe("Hello World");
  });

  test("explicit templateFormat option overrides saved template_format", () => {
    const prompt = new Prompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          template_format: "nunjucks",
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "chat",
            messages: [{ role: "user", content: "Hello {{name}}" }],
          },
        },
      },
      {},
      true,
    );

    // Override with mustache
    const result = prompt.build(
      { name: "World" },
      { templateFormat: "mustache" },
    );
    expect(result.messages[0].content).toBe("Hello World");
  });

  test("template_format applies to completion prompts", () => {
    const prompt = new Prompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          template_format: "nunjucks",
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "completion",
            content: "Complete this: {% if text %}{{text}}{% endif %}",
          },
        },
      },
      {},
      true,
    );

    expect(() =>
      prompt.build({ text: "Hello" }, { flavor: "completion" }),
    ).toThrow(
      "Nunjucks templating requires @braintrust/template-nunjucks. Install and import it to enable templateFormat: 'nunjucks'.",
    );
  });

  test("supports responses flavor in build()", () => {
    const prompt = new Prompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "chat",
            messages: [{ role: "user", content: "Hello {{name}}" }],
            tools: JSON.stringify([
              {
                type: "function",
                function: {
                  name: "greet",
                  parameters: {
                    type: "object",
                    properties: {},
                  },
                },
              },
            ]),
          },
        },
      },
      {},
      true,
    );

    const result = prompt.build({ name: "World" }, { flavor: "responses" });

    expect(result).toMatchObject({
      model: "gpt-4o",
      input: [{ role: "user", content: "Hello World" }],
      tools: [
        {
          type: "function",
          function: {
            name: "greet",
          },
        },
      ],
    });
    expect(result).not.toHaveProperty("messages");
  });

  test("supports responses flavor in buildWithAttachments()", async () => {
    const prompt = new Prompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "chat",
            messages: [{ role: "user", content: "Hello {{name}}" }],
          },
        },
      },
      {},
      true,
    );

    const result = await prompt.buildWithAttachments(
      { name: "World" },
      { flavor: "responses" },
    );

    expectTypeOf(result).toMatchTypeOf<CompiledPrompt<"responses">>();
    expect(result).toMatchObject({
      model: "gpt-4o",
      input: [{ role: "user", content: "Hello World" }],
    });
    expect(result).not.toHaveProperty("messages");
  });
});

describe("prompt template_format (unconfigured/browser-like)", () => {
  test("throws unsupported error for nunjucks template_format when not configured", async () => {
    vi.resetModules();
    const { Prompt: UnconfiguredPrompt } = await import("./logger");

    const prompt = new UnconfiguredPrompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          template_format: "nunjucks",
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "Hello {% if name %}{{name}}{% endif %}",
              },
            ],
          },
        },
      },
      {},
      true,
    );

    expect(() => prompt.build({ name: "World" })).toThrowError(
      /Nunjucks templating requires @braintrust\/template-nunjucks/,
    );
  });
  test("throws unsupported error after configureBrowser()", async () => {
    vi.resetModules();
    const { configureBrowser } = await import("./browser/config");
    const { Prompt: BrowserConfiguredPrompt } = await import("./logger");

    configureBrowser();

    const prompt = new BrowserConfiguredPrompt(
      {
        id: "1",
        _xact_id: "xact_123",
        created: "2023-10-01T00:00:00Z",
        project_id: "project_123",
        prompt_session_id: "session_123",
        name: "test",
        slug: "test",
        prompt_data: {
          template_format: "nunjucks",
          options: {
            model: "gpt-4o",
          },
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "Hello {% if name %}{{name}}{% endif %}",
              },
            ],
          },
        },
      },
      {},
      true,
    );

    expect(() => prompt.build({ name: "World" })).toThrowError(
      /Nunjucks templating requires @braintrust\/template-nunjucks/,
    );
  });
});
