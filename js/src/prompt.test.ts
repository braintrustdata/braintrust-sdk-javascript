import { beforeAll, describe, test, expect, expectTypeOf, vi } from "vitest";
import { configureNode } from "./node/config";
import { Prompt } from "./logger";
import { validateParameters } from "./eval-parameters";
import { evaluatorDefinitionsSchema } from "../dev/types";
import { serializeRemoteEvalParametersContainer } from "./framework2";
import type { OpenAIDecisionCreateParams } from "./vendor-sdk-types/openai-decisions";
import {
  type PromptData,
  promptDefinitionToPromptData,
  promptDefinitionSchema,
} from "./prompt-schemas";

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

describe("decisions prompts", () => {
  const definition = {
    model: "decision-model",
    input: "Evaluate {{text}}",
    questions: [
      {
        type: "predicate" as const,
        name: "{{name}}",
        instructions: "Is {{text}} safe?",
      },
      {
        type: "choice" as const,
        instructions: "Choose {{topic}}",
        choices: [
          { value: "{{topic}}", description: "About {{topic}}" },
          { value: false },
        ],
      },
      {
        type: "score" as const,
        instructions: "Rate {{text}}",
        levels: [
          { label: "{{level}}", description: "Very {{level}}" },
          { label: "low" },
        ],
      },
    ],
  };
  const args = {
    text: "hello",
    name: "safe",
    topic: "greeting",
    level: "high",
  };

  test("accepts decisions prompts as eval parameter values", async () => {
    const schema = { prompt: { type: "prompt" as const } };
    const { prompt } = await validateParameters<typeof schema>(
      { prompt: promptDefinitionToPromptData(definition) },
      schema,
    );
    expect(prompt.build(args, { flavor: "decisions" }).input).toBe(
      "Evaluate hello",
    );
  });

  test("round-trips decisions prompt defaults through evaluator manifests", () => {
    const parameters = serializeRemoteEvalParametersContainer({
      prompt: { type: "prompt", default: definition },
    });
    const manifest = { evaluator: { parameters } };
    const parsed = evaluatorDefinitionsSchema.parse(manifest);
    expect(parsed).toEqual(manifest);
    const serialized = parsed.evaluator.parameters;
    if (serialized?.type !== "braintrust.staticParameters") {
      throw new Error("Expected static parameters");
    }
    const parameter = serialized.schema.prompt;
    if (parameter.type !== "prompt" || !parameter.default) {
      throw new Error("Expected a prompt default");
    }
    const prompt = Prompt.fromPromptData("decisions", parameter.default);
    expect(prompt.build(args, { flavor: "decisions" }).input).toBe(
      "Evaluate hello",
    );
  });

  test("builds code-defined prompts and preserves question value types", () => {
    const data = promptDefinitionToPromptData(
      promptDefinitionSchema.parse(definition),
    );
    const original = structuredClone(data);
    const prompt = Prompt.fromPromptData("decisions", data);
    const built = prompt.build(args, { flavor: "decisions", strict: true });
    expectTypeOf(built).toMatchTypeOf<OpenAIDecisionCreateParams>();
    expect(built).toMatchObject({
      model: "decision-model",
      input: "Evaluate hello",
      questions: [
        { type: "predicate", name: "safe", instructions: "Is hello safe?" },
        {
          type: "choice",
          instructions: "Choose greeting",
          choices: [
            { value: "greeting", description: "About greeting" },
            { value: false },
          ],
        },
        {
          type: "score",
          instructions: "Rate hello",
          levels: [
            { label: "high", description: "Very high" },
            { label: "low" },
          ],
        },
      ],
    });
    expect(built).not.toHaveProperty("messages");
    expect(built).not.toHaveProperty("type");
    expect(data).toEqual(original);
  });

  test("renders decisions messages with provider-compatible text and image parts", () => {
    const prompt = Prompt.fromPromptData("decisions", {
      options: { model: "decision-model" },
      prompt: {
        type: "decisions",
        input: [
          { role: "user", content: "Evaluate {{topic}}" },
          {
            role: "user",
            type: "message",
            content: [
              {
                type: "input_text",
                text: "{{text}}",
              },
              {
                type: "input_image",
                image_url: "https://example.com/{{topic}}.png",
                detail: "low",
              },
            ],
          },
        ],
        questions: [],
      },
    });
    const built = prompt.build(args, { flavor: "decisions" });
    expectTypeOf(built).toMatchTypeOf<OpenAIDecisionCreateParams>();
    expect(built.input).toEqual([
      { role: "user", content: "Evaluate greeting" },
      {
        role: "user",
        type: "message",
        content: [
          { type: "input_text", text: "hello" },
          {
            type: "input_image",
            image_url: "https://example.com/greeting.png",
            detail: "low",
          },
        ],
      },
    ]);
  });

  test.each([
    { role: "system", content: "text" },
    { role: "developer", content: "text" },
    { role: "assistant", content: "text" },
    { role: "user", content: [{ type: "text", text: "text" }] },
  ])("rejects chat-only message formats: %j", (message) => {
    expect(
      promptDefinitionSchema.safeParse({ ...definition, input: [message] })
        .success,
    ).toBe(false);
  });

  test.each([
    { input: "{{missing}}", questions: [] },
    {
      input: [
        {
          role: "user" as const,
          content: [{ type: "input_text" as const, text: "{{missing}}" }],
        },
      ],
      questions: [],
    },
    {
      input: [
        {
          role: "user" as const,
          content: [{ type: "input_image" as const, image_url: "{{missing}}" }],
        },
      ],
      questions: [],
    },
    {
      input: "text",
      questions: [{ type: "predicate" as const, instructions: "{{missing}}" }],
    },
    {
      input: "text",
      questions: [
        {
          type: "choice" as const,
          instructions: "choose",
          choices: [{ value: false, description: "{{missing}}" }],
        },
      ],
    },
    {
      input: "text",
      questions: [
        {
          type: "score" as const,
          instructions: "rate",
          levels: [{ label: "{{missing}}" }],
        },
      ],
    },
  ])("applies strict mode to input and questions: %j", (contents) => {
    const prompt = Prompt.fromPromptData("decisions", {
      options: { model: "decision-model" },
      prompt: { type: "decisions", ...contents },
    });
    expect(() =>
      prompt.build({}, { flavor: "decisions", strict: true }),
    ).toThrow();
    expect(() =>
      prompt.build({}, { flavor: "decisions", strict: false }),
    ).not.toThrow();
  });

  test("honors saved template format and build overrides", () => {
    const prompt = Prompt.fromPromptData("decisions", {
      ...promptDefinitionToPromptData(definition),
      template_format: "none",
    });
    expect(prompt.build(args, { flavor: "decisions" })).toMatchObject(
      definition,
    );
    expect(
      prompt.build(args, { flavor: "decisions", templateFormat: "mustache" })
        .input,
    ).toBe("Evaluate hello");
  });

  test("uses the shared renderer for nunjucks", () => {
    const prompt = Prompt.fromPromptData(
      "decisions",
      promptDefinitionToPromptData(definition),
    );
    expect(() =>
      prompt.build(args, { flavor: "decisions", templateFormat: "nunjucks" }),
    ).toThrow("Nunjucks templating requires");
  });

  test("requires an explicit matching flavor and rejects extra messages", () => {
    const prompt = Prompt.fromPromptData(
      "decisions",
      promptDefinitionToPromptData(definition),
    );
    expect(() => prompt.build(args)).toThrow("Use flavor: 'decisions' instead");
    expect(() => prompt.build(args, { flavor: "completion" })).toThrow(
      "Use flavor: 'decisions' instead",
    );
    expect(() =>
      prompt.build(args, {
        flavor: "decisions",
        messages: [{ role: "user", content: "extra" }],
      }),
    ).toThrow("extra messages are not supported for decisions prompts");
    const chat = Prompt.fromPromptData("chat", {
      options: { model: "chat-model" },
      prompt: { type: "chat", messages: [] },
    });
    expect(() => chat.build({}, { flavor: "decisions" })).toThrow(
      "Use flavor: 'chat' instead",
    );
  });

  test.each([true, false])(
    "preserves prompt metadata and noTrace=%s in both build methods",
    async (noTrace) => {
      const prompt = new Prompt(
        {
          id: "prompt-id",
          project_id: "project-id",
          _xact_id: "version",
          name: "decisions",
          slug: "decisions",
          prompt_data: promptDefinitionToPromptData(definition),
        },
        { temperature: 0.2 },
        noTrace,
      );
      const built = prompt.build(args, { flavor: "decisions" });
      expect(built.temperature).toBe(0.2);
      expect(
        await prompt.buildWithAttachments(args, { flavor: "decisions" }),
      ).toEqual(built);
      if (noTrace) {
        expect(built).not.toHaveProperty("span_info");
      } else {
        expect(built.span_info?.metadata.prompt).toEqual({
          id: "prompt-id",
          project_id: "project-id",
          version: "version",
          variables: args,
        });
      }
    },
  );
});
