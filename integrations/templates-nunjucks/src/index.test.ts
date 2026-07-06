import { describe, test, expect, beforeAll } from "vitest";
import { registerTemplatePlugin, Prompt } from "braintrust";
import { nunjucksPlugin } from "./index";

const promptRow = (row: unknown) => row as any;

// Register and activate the plugin for all tests
beforeAll(() => {
  // registerTemplatePlugin will auto-activate using the plugin's
  // `defaultOptions` when available.
  registerTemplatePlugin(nunjucksPlugin);
});

describe("nunjucks rendering via Prompt", () => {
  test("renders variable and control structures", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content:
                  "Hello {{ name | upper }} {% if age > 18 %}Adult{% else %}Minor{% endif %}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { name: "alice", age: 30 },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("Hello ALICE Adult");
  });

  test("loops render", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: `{% for item in items %}{{ item }},{% endfor %}`,
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { items: ["a", "b"] },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("a,b,");
  });

  test("strict mode throws for missing top-level variable", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "Hello {{ name }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt.build({ user: "x" }, { templateFormat: "nunjucks", strict: true }),
    ).toThrow();
  });

  test("strict mode passes for defined variable and filters", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "Hello {{ name | upper }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt.build(
        { name: "alice" },
        { templateFormat: "nunjucks", strict: true },
      ),
    ).not.toThrow();
  });

  test("strict mode: for over undefined is empty (does not throw)", () => {
    const prompt1 = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: `{% for item in items %}{{ item }}{% endfor %}`,
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt1.build(
        { items: [1, 2, 3] },
        { templateFormat: "nunjucks", strict: true },
      ),
    ).not.toThrow();

    expect(() =>
      prompt1.build({}, { templateFormat: "nunjucks", strict: true }),
    ).not.toThrow();
  });

  test("strict mode: nested path with numeric index using brackets", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: `{{ user.addresses[2].city }}`,
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const ok = { user: { addresses: [{}, {}, { city: "SF" }] } };
    expect(() =>
      prompt.build(ok, { templateFormat: "nunjucks", strict: true }),
    ).not.toThrow();

    const bad = { user: {} };
    expect(() =>
      prompt.build(bad, { templateFormat: "nunjucks", strict: true }),
    ).toThrow();
  });

  test("renders nested object properties", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ user.profile.name }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { user: { profile: { name: "Alice" } } },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("Alice");
  });

  test("renders multiple variables with context", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content:
                  "{{ firstName }} {{ lastName }} is {{ age }} years old",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { firstName: "Bob", lastName: "Smith", age: 25 },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("Bob Smith is 25 years old");
  });

  test("renders with string concatenation", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ greeting ~ ' ' ~ name }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { greeting: "Hello", name: "World" },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("Hello World");
  });

  test("renders numeric operations", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "Total: {{ price * quantity }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { price: 10, quantity: 3 },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("Total: 30");
  });

  test("renders with filters and context", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ message | upper | trim }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { message: "  hello world  " },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("HELLO WORLD");
  });

  test("renders array elements with index", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "First: {{ items[0] }}, Last: {{ items[2] }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { items: ["apple", "banana", "cherry"] },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("First: apple, Last: cherry");
  });

  test("renders nested arrays and objects", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ users[0].name }} from {{ users[0].city }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      {
        users: [
          { name: "John", city: "NYC" },
          { name: "Jane", city: "LA" },
        ],
      },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("John from NYC");
  });

  test("renders with default filter", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ name | default('Guest') }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result1 = prompt.build(
      { name: "Alice" },
      { templateFormat: "nunjucks" },
    );
    expect(result1.messages[0]?.content).toBe("Alice");

    const result2 = prompt.build({}, { templateFormat: "nunjucks" });
    expect(result2.messages[0]?.content).toBe("Guest");
  });

  test("renders ternary expressions", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ user.name if user else 'Anonymous' }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result1 = prompt.build(
      { user: { name: "Alice" } },
      { templateFormat: "nunjucks" },
    );
    expect(result1.messages[0]?.content).toBe("Alice");

    const result2 = prompt.build({}, { templateFormat: "nunjucks" });
    expect(result2.messages[0]?.content).toBe("Anonymous");
  });

  test("renders with multiple filters chained", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ text | lower | trim }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { text: "  HELLO WORLD  " },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("hello world");
  });

  test("renders complex nested context", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content:
                  "{{ order.customer.name }} ordered {{ order.items[0].name }} for ${{ order.total }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      {
        order: {
          customer: { name: "Alice" },
          items: [{ name: "Widget", price: 10 }],
          total: 10,
        },
      },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("Alice ordered Widget for $10");
  });

  test("renders with length filter on arrays", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "You have {{ items | length }} items",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { items: ["a", "b", "c", "d"] },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("You have 4 items");
  });

  test("renders with join filter", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ tags | join(', ') }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    const result = prompt.build(
      { tags: ["red", "green", "blue"] },
      { templateFormat: "nunjucks" },
    );
    expect(result.messages[0]?.content).toBe("red, green, blue");
  });
});

describe("nunjucks linting", () => {
  test("lint throws for missing variable", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "Hello {{ user.name }}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt.build({}, { templateFormat: "nunjucks", strict: true }),
    ).toThrow();
  });

  test("lint passes for valid template with loops", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: `{% for item in items %}{{ item }}{% endfor %}`,
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt.build({}, { templateFormat: "nunjucks", strict: true }),
    ).not.toThrow();
  });

  test("lint passes for valid template with conditionals", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: `{% if user %}{{ user.name }}{% endif %}`,
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt.build({}, { templateFormat: "nunjucks", strict: true }),
    ).not.toThrow();
  });

  test("lint throws for invalid template syntax", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{{ unclosed",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt.build({}, { templateFormat: "nunjucks", strict: true }),
    ).toThrow();
  });

  test("lint throws for mismatched tags", () => {
    const prompt = new Prompt(
      promptRow({
        name: "test-prompt",
        slug: "test-prompt",
        prompt_data: {
          prompt: {
            type: "chat",
            messages: [
              {
                role: "user",
                content: "{% if x %}{% endfor %}",
              },
            ],
          },
          options: { model: "gpt-4" },
        },
      }),
      {},
      false,
    );

    expect(() =>
      prompt.build({}, { templateFormat: "nunjucks", strict: true }),
    ).toThrow();
  });
});
