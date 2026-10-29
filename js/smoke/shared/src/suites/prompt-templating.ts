/**
 * Prompt templating test suite
 * Tests Mustache and Nunjucks template rendering in Prompt class
 */

import { assertEqual } from "../helpers/assertions";
import { register, type TestFn } from "../helpers/register";

export const testMustacheTemplate: TestFn = register(
  "testMustacheTemplate",
  async (module) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Prompt = module.Prompt as any;

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

    assertEqual(
      mustacheResult.messages[0]?.content,
      "Hello, World!",
      "Mustache template should render simple variable",
    );

    return "Mustache template test passed";
  },
);

export const testNunjucksTemplate: TestFn = register(
  "testNunjucksTemplate",
  async (module) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Prompt = module.Prompt as any;

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

    const nunjucksResult = nunjucksPrompt.build(
      {
        items: [{ name: "apple" }, { name: "banana" }, { name: "cherry" }],
      },
      { templateFormat: "nunjucks" },
    );

    assertEqual(
      nunjucksResult.messages[0]?.content,
      "Items: apple, banana, cherry",
      "Nunjucks template should render loop correctly",
    );

    return "Nunjucks template test passed";
  },
);
