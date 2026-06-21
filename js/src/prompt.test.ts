import { beforeAll, describe, test, expect, expectTypeOf, vi } from "vitest";
import type { ResponseCreateParams } from "openai/resources/responses/responses";
import { configureNode } from "./node/config";
import { type CompiledPrompt, Prompt } from "./logger";
import { type PromptDataType as PromptData } from "./generated_types";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function omitSpanInfo<T extends { span_info?: unknown }>(
  prompt: T,
): DistributiveOmit<T, "span_info"> {
  const { span_info: _spanInfo, ...responseParams } = prompt;
  return responseParams as DistributiveOmit<T, "span_info">;
}

function assertResponseCreateParams(
  params: ResponseCreateParams,
): ResponseCreateParams {
  return params;
}

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
    const responseParams = assertResponseCreateParams(omitSpanInfo(result));

    expectTypeOf(result).toExtend<CompiledPrompt<"responses">>();
    expect(responseParams).toMatchObject({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: "Hello World",
        },
      ],
      tools: [
        {
          type: "function",
          name: "greet",
        },
      ],
    });
    expect(responseParams).not.toHaveProperty("messages");
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
    const responseParams = assertResponseCreateParams(omitSpanInfo(result));

    expectTypeOf(result).toExtend<CompiledPrompt<"responses">>();
    expect(responseParams).toMatchObject({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: "Hello World",
        },
      ],
    });
    expect(responseParams).not.toHaveProperty("messages");
  });

  test("responses flavor maps chat params to responses params", () => {
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
            params: {
              max_tokens: 42,
              reasoning_effort: "low",
              verbosity: "high",
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "schema",
                  schema: {
                    type: "object",
                    properties: {
                      greeting: { type: "string" },
                    },
                  },
                  strict: true,
                },
              },
              tool_choice: {
                type: "function",
                function: { name: "greet" },
              },
            },
          },
          prompt: {
            type: "chat",
            messages: [{ role: "user", content: "Hello {{name}}" }],
            tools: JSON.stringify([
              {
                type: "function",
                function: {
                  name: "greet",
                  description: "Greet the user",
                  strict: true,
                  parameters: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                    },
                    required: ["name"],
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
    const responseParams = assertResponseCreateParams(omitSpanInfo(result));

    expect(responseParams).toMatchObject({
      model: "gpt-4o",
      max_output_tokens: 42,
      reasoning: { effort: "low" },
      text: {
        verbosity: "high",
        format: {
          type: "json_schema",
          name: "schema",
          strict: true,
          schema: {
            type: "object",
            properties: {
              greeting: { type: "string" },
            },
          },
        },
      },
      tool_choice: {
        type: "function",
        name: "greet",
      },
      tools: [
        {
          type: "function",
          name: "greet",
          description: "Greet the user",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
          },
        },
      ],
    });
    expect(responseParams).not.toHaveProperty("max_tokens");
    expect(responseParams).not.toHaveProperty("response_format");
    expect(responseParams).not.toHaveProperty("reasoning_effort");
  });

  test("responses flavor converts tool-call message history to input items", () => {
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
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "What is the weather in Paris?",
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: "https://example.com/weather-map.png",
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      {},
      true,
    );

    const result = prompt.build(
      {},
      {
        flavor: "responses",
        messages: [
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"Paris"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_123",
            content: "Sunny and 72F",
          },
        ],
      },
    );
    const responseParams = assertResponseCreateParams(omitSpanInfo(result));

    expect(responseParams.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "What is the weather in Paris?",
          },
          {
            type: "input_image",
            image_url: "https://example.com/weather-map.png",
            detail: "auto",
          },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: "Let me check.",
      },
      {
        type: "function_call",
        call_id: "call_123",
        name: "get_weather",
        arguments: '{"location":"Paris"}',
      },
      {
        type: "function_call_output",
        call_id: "call_123",
        output: "Sunny and 72F",
      },
    ]);
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
