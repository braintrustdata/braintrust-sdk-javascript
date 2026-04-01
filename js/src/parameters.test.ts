import { expect, test, beforeAll } from "vitest";
import { validateParameters } from "./eval-parameters";
import { runEvaluator } from "./framework";
import { RemoteEvalParameters } from "./logger";
import { z } from "zod/v3";
import { type ProgressReporter } from "./reporters/types";
import { configureNode } from "./node/config";

beforeAll(() => {
  configureNode();
});

class NoopProgressReporter implements ProgressReporter {
  public start() {}
  public stop() {}
  public increment() {}
}

test("parameters are passed to task", async () => {
  const out = await runEvaluator(
    null,
    {
      projectName: "test-parameters",
      evalName: "test",
      data: [{ input: "hello" }],
      task: async (input: string, { parameters }) => {
        const output = `${parameters.prefix}${input}${parameters.suffix}`;
        return output;
      },
      scores: [],
      parameters: {
        prefix: z.string().default("start:"),
        suffix: z.string().default(":end"),
      },
    },
    new NoopProgressReporter(),
    [],
    undefined,
    { prefix: "start:", suffix: ":end" },
    true,
  );

  expect(out.results).toHaveLength(1);
  expect(out.results[0].output).toBe("start:hello:end");
});

test("prompt parameter is passed correctly", async () => {
  const result = await runEvaluator(
    null,
    {
      projectName: "test-prompt-parameter",
      evalName: "test",
      data: [{ input: "test input" }],
      task: async (input: string, { parameters }) => {
        // Verify the prompt parameter has the expected structure
        if (!parameters.main || typeof parameters.main.build !== "function") {
          throw new Error(
            "Prompt parameter 'main' is missing or does not have a build function",
          );
        }
        return input;
      },
      scores: [],
      parameters: {
        main: {
          type: "prompt",
          name: "Main prompt",
          description: "Test prompt",
          default: {
            messages: [
              {
                role: "user",
                content: "{{input}}",
              },
            ],
            model: "gpt-4",
          },
        },
      },
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(result.results).toHaveLength(1);
  expect(result.results[0].output).toBe("test input");
});

test("remote prompt parameter is rehydrated correctly", async () => {
  const parameters = new RemoteEvalParameters<
    true,
    true,
    {
      main: {
        build: (args: { input: string }) => {
          messages: Array<{ role: string; content: string }>;
          model?: string;
        };
      };
    }
  >({
    id: "11111111-1111-4111-8111-111111111111",
    _xact_id: "v1",
    project_id: "22222222-2222-4222-8222-222222222222",
    name: "Saved parameters",
    slug: "saved-parameters",
    function_type: "parameters",
    function_data: {
      type: "parameters",
      data: {
        main: {
          prompt: {
            type: "chat",
            messages: [{ role: "user", content: "{{input}}" }],
          },
          options: {
            model: "gpt-5-mini",
          },
        },
      },
      __schema: {
        type: "object",
        properties: {
          main: {
            type: "object",
            "x-bt-type": "prompt",
          },
        },
        additionalProperties: true,
      },
    },
  });

  const validated = await validateParameters({}, parameters);

  expect(validated.main.build({ input: "test input" })).toMatchObject({
    messages: [{ role: "user", content: "test input" }],
    model: "gpt-5-mini",
  });
});

test("custom parameter values override defaults", async () => {
  const result = await runEvaluator(
    null,
    {
      projectName: "test-custom-parameters",
      evalName: "test",
      data: [{ input: "hello" }],
      task: async (input: string, { parameters }) => {
        const output = `${parameters.prefix}${input}${parameters.suffix}`;
        return output;
      },
      scores: [],
      parameters: {
        prefix: z.string().default("start:"),
        suffix: z.string().default(":end"),
      },
    },
    new NoopProgressReporter(),
    [],
    undefined,
    {
      prefix: "custom:",
      suffix: ":custom",
    },
    true,
  );

  expect(result.results).toHaveLength(1);
  expect(result.results[0].output).toBe("custom:hello:custom");
});

test("array parameter is handled correctly", async () => {
  const result = await runEvaluator(
    null,
    {
      projectName: "test-array-parameter",
      evalName: "test",
      data: [{ input: "test" }],
      task: async (input: string, { parameters }) => {
        expect(Array.isArray(parameters.items)).toBe(true);
        expect(parameters.items).toEqual(["item1", "item2"]);
        return input;
      },
      scores: [],
      parameters: {
        items: z.array(z.string()).default(["item1", "item2"]),
      },
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(result.results).toHaveLength(1);
  expect(result.results[0].output).toBe("test");
});

test("object parameter is handled correctly", async () => {
  const result = await runEvaluator(
    null,
    {
      projectName: "test-object-parameter",
      evalName: "test",
      data: [{ input: "test" }],
      task: async (input: string, { parameters }) => {
        expect(parameters.config).toEqual({
          name: "test",
          value: 123,
        });
        return input;
      },
      scores: [],
      parameters: {
        config: z
          .object({
            name: z.string(),
            value: z.number(),
          })
          .default({
            name: "test",
            value: 123,
          }),
      },
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(result.results).toHaveLength(1);
  expect(result.results[0].output).toBe("test");
});

test("model parameter defaults to configured value", async () => {
  const result = await runEvaluator(
    null,
    {
      projectName: "test-model-parameter-default",
      evalName: "test",
      data: [{ input: "test" }],
      task: async (input: string, { parameters }) => {
        expect(parameters.model).toBe("gpt-5-mini");
        return input;
      },
      scores: [],
      parameters: {
        model: {
          type: "model",
          default: "gpt-5-mini",
        },
      },
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(result.results).toHaveLength(1);
  expect(result.results[0].output).toBe("test");
});

test("model parameter is required when default is missing", async () => {
  await expect(
    runEvaluator(
      null,
      {
        projectName: "test-model-parameter-required",
        evalName: "test",
        data: [{ input: "test" }],
        task: async (input: string) => input,
        scores: [],
        parameters: {
          model: {
            type: "model",
          },
        },
      },
      new NoopProgressReporter(),
      [],
      undefined,
      undefined,
      true,
    ),
  ).rejects.toThrow("Parameter 'model' is required");
});
