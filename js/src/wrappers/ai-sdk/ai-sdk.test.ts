/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import {
  test,
  assert,
  beforeEach,
  beforeAll,
  afterEach,
  describe,
  expectTypeOf,
  expect,
} from "vitest";
import { configureNode } from "../../node/config";
import * as ai from "ai";
import { openai } from "@ai-sdk/openai";
import {
  _exportsForTestingOnly,
  initLogger,
  Logger,
  TestBackgroundLogger,
} from "../../logger";
import { wrapAISDK, wrapAgentClass, omit, extractTokenMetrics } from "./ai-sdk";
import { getCurrentUnixTimestamp } from "../../util";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

const TEST_MODEL = "gpt-4o-mini";
const TEST_SUITE_OPTIONS = { timeout: 30000, retry: 3 };
const FIXTURES_DIR = join(__dirname, "fixtures");

try {
  configureNode();
} catch {}

test("ai sdk is installed", () => {
  assert.ok(ai);
});

describe("ai sdk client unit tests", TEST_SUITE_OPTIONS, () => {
  let wrappedAI: typeof ai;
  let backgroundLogger: TestBackgroundLogger;
  let _logger: Logger<false>;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    wrappedAI = wrapAISDK(ai);
    _logger = initLogger({
      projectName: "ai-sdk.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("ai wrapping preserves type", () => {
    const wrapped = wrapAISDK(ai);
    expectTypeOf(wrapped.generateText).toEqualTypeOf<typeof ai.generateText>();
    expectTypeOf(wrapped.streamText).toEqualTypeOf<typeof ai.streamText>();
    expectTypeOf(wrapped.generateObject).toEqualTypeOf<
      typeof ai.generateObject
    >();
    expectTypeOf(wrapped.streamObject).toEqualTypeOf<typeof ai.streamObject>();
  });

  test("ai sdk basic completion", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = openai(TEST_MODEL);
    const start = getCurrentUnixTimestamp();

    const result = await wrappedAI.generateText({
      model,
      messages: [
        {
          role: "user",
          content: "What is the capital of France? Answer in one word.",
        },
      ],
      maxOutputTokens: 100,
    });

    const end = getCurrentUnixTimestamp();
    assert.ok(result);
    assert.ok(result.text);
    expect(result.text.toLowerCase()).toContain("paris");

    const spans = await backgroundLogger.drain();
    // 2 spans: parent generateText + child doGenerate (per-step LLM call)
    expect(spans).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(span).toMatchObject({
      project_id: expect.any(String),
      log_id: expect.any(String),
      created: expect.any(String),
      span_id: expect.any(String),
      root_span_id: expect.any(String),
      span_attributes: {
        type: "llm",
        name: "generateText",
      },
      metadata: expect.objectContaining({
        model: TEST_MODEL,
      }),
      input: expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "What is the capital of France? Answer in one word.",
          }),
        ]),
      }),
      metrics: expect.objectContaining({
        start: expect.any(Number),
        end: expect.any(Number),
      }),
    });

    const { metrics } = span;
    expect(start).toBeLessThanOrEqual(metrics.start);
    expect(metrics.start).toBeLessThanOrEqual(metrics.end);
    expect(metrics.end).toBeLessThanOrEqual(end);

    // Token/cost metrics live on the child doGenerate span to avoid
    // double-counting. Parent span should NOT have them.
    expect(metrics.tokens).toBeUndefined();
    expect(metrics.prompt_tokens).toBeUndefined();
    expect(metrics.completion_tokens).toBeUndefined();

    // Verify child doGenerate span carries the metrics
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenSpan = spans.find(
      (s: any) => s.span_attributes?.name === "doGenerate",
    ) as any;
    expect(doGenSpan).toBeDefined();
    expect(doGenSpan.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(doGenSpan.metrics.completion_tokens).toBeGreaterThan(0);

    // Check that output is present and not omitted
    expect(span.output).toBeDefined();
    expect(span.output).not.toBe("<omitted>");
    // Note: response.body is intentionally omitted by DENY_OUTPUT_PATHS configuration
    if (
      span.output &&
      typeof span.output === "object" &&
      span.output.response
    ) {
      expect(span.output.response.body).toBe("<omitted>");
    }
  });

  test("braintrust fingerprint metadata", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = openai(TEST_MODEL);

    await wrappedAI.generateText({
      model,
      messages: [
        {
          role: "user",
          content: "Say hello",
        },
      ],
      maxOutputTokens: 16,
    });

    const spans = await backgroundLogger.drain();
    // 2 spans: parent generateText + child doGenerate
    expect(spans).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    // Verify braintrust fingerprint metadata
    expect(span.metadata.braintrust).toBeDefined();
    expect(span.metadata.braintrust).toMatchObject({
      integration_name: "ai-sdk",
      sdk_language: "typescript",
    });
  });

  test("ai sdk image input", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const imageBuffer = readFileSync(join(FIXTURES_DIR, "test-image.png"));

    const model = openai(TEST_MODEL);
    const start = getCurrentUnixTimestamp();

    const result = await wrappedAI.generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: imageBuffer,
              mimeType: "image/png",
            },
            { type: "text", text: "What color is this image?" },
          ],
        },
      ],
      maxOutputTokens: 100,
    });

    const end = getCurrentUnixTimestamp();
    assert.ok(result);
    assert.ok(result.text);

    // The image contains blue/teal tones (based on the test-image.png)
    const lowerText = result.text.toLowerCase();
    expect(
      lowerText.includes("blue") ||
        lowerText.includes("teal") ||
        lowerText.includes("turquoise"),
    ).toBe(true);

    const spans = await backgroundLogger.drain();
    // 2 spans: parent generateText + child doGenerate
    expect(spans).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(span).toMatchObject({
      project_id: expect.any(String),
      log_id: expect.any(String),
      created: expect.any(String),
      span_id: expect.any(String),
      root_span_id: expect.any(String),
      span_attributes: {
        type: "llm",
        name: "generateText",
      },
      metadata: expect.objectContaining({
        model: TEST_MODEL,
      }),
      input: expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "image",
              }),
              expect.objectContaining({
                type: "text",
                text: "What color is this image?",
              }),
            ]),
          }),
        ]),
      }),
      metrics: expect.objectContaining({
        start: expect.any(Number),
        end: expect.any(Number),
      }),
    });

    const { metrics } = span;
    expect(start).toBeLessThanOrEqual(metrics.start);
    expect(metrics.start).toBeLessThanOrEqual(metrics.end);
    expect(metrics.end).toBeLessThanOrEqual(end);

    // Token/cost metrics live on the child doGenerate span to avoid
    // double-counting. Parent span should NOT have them.
    expect(metrics.tokens).toBeUndefined();
    expect(metrics.prompt_tokens).toBeUndefined();
    expect(metrics.completion_tokens).toBeUndefined();

    // Verify child doGenerate span carries the metrics
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenSpan = spans.find(
      (s: any) => s.span_attributes?.name === "doGenerate",
    ) as any;
    expect(doGenSpan).toBeDefined();
    expect(doGenSpan.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(doGenSpan.metrics.completion_tokens).toBeGreaterThan(0);

    // Verify image content is properly handled as attachment
    const messageContent = span.input.messages[0].content;
    expect(messageContent).toBeInstanceOf(Array);
    const imageContent = messageContent.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c.type === "image",
    );
    expect(imageContent).toBeDefined();

    // Check that the image was converted to an attachment
    if (imageContent && imageContent.image) {
      expect(imageContent.image.reference).toMatchObject({
        type: "braintrust_attachment",
        key: expect.any(String),
        content_type: "image/png",
      });
    }
  });

  test("ai sdk document input", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const base64Pdf = readFileSync(
      join(FIXTURES_DIR, "test-document.pdf"),
      "base64",
    );

    const model = openai(TEST_MODEL);
    const start = getCurrentUnixTimestamp();

    const result = await wrappedAI.generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: base64Pdf,
              mediaType: "application/pdf",
              filename: "test-document.pdf",
            },
            { type: "text", text: "What is in this document?" },
          ],
        },
      ],
      maxOutputTokens: 150,
    });

    const end = getCurrentUnixTimestamp();
    assert.ok(result);
    assert.ok(result.text);

    const spans = await backgroundLogger.drain();
    // 2 spans: parent generateText + child doGenerate
    expect(spans).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(span).toMatchObject({
      project_id: expect.any(String),
      log_id: expect.any(String),
      created: expect.any(String),
      span_id: expect.any(String),
      root_span_id: expect.any(String),
      span_attributes: {
        type: "llm",
        name: "generateText",
      },
      metadata: expect.objectContaining({
        model: TEST_MODEL,
      }),
      input: expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "file",
              }),
              expect.objectContaining({
                type: "text",
                text: "What is in this document?",
              }),
            ]),
          }),
        ]),
      }),
      metrics: expect.objectContaining({
        start: expect.any(Number),
        end: expect.any(Number),
      }),
    });

    const { metrics } = span;
    expect(start).toBeLessThanOrEqual(metrics.start);
    expect(metrics.start).toBeLessThanOrEqual(metrics.end);
    expect(metrics.end).toBeLessThanOrEqual(end);

    // Token/cost metrics live on the child doGenerate span to avoid
    // double-counting. Parent span should NOT have them.
    expect(metrics.tokens).toBeUndefined();
    expect(metrics.prompt_tokens).toBeUndefined();
    expect(metrics.completion_tokens).toBeUndefined();

    // Verify child doGenerate span carries the metrics
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenSpan = spans.find(
      (s: any) => s.span_attributes?.name === "doGenerate",
    ) as any;
    expect(doGenSpan).toBeDefined();
    expect(doGenSpan.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(doGenSpan.metrics.completion_tokens).toBeGreaterThan(0);

    // Verify file content is properly handled as attachment
    const messageContent = span.input.messages[0].content;
    expect(messageContent).toBeInstanceOf(Array);
    const fileContent = messageContent.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c.type === "file",
    );
    expect(fileContent).toBeDefined();

    // Check that the file was converted to an attachment reference
    if (fileContent && fileContent.data) {
      expect(fileContent.data.reference).toMatchObject({
        type: "braintrust_attachment",
        key: expect.any(String),
        content_type: "application/pdf",
      });
      // Ensure the raw base64 data is NOT in the input
      expect(typeof fileContent.data).toBe("object");
      expect(fileContent.data).not.toBe(base64Pdf);
    }
  });

  test("ai sdk streaming completion", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = openai(TEST_MODEL);
    const start = getCurrentUnixTimestamp();

    const stream = await wrappedAI.streamText({
      model,
      messages: [
        {
          role: "user",
          content: "Count from 1 to 5.",
        },
      ],
      maxOutputTokens: 100,
    });

    let ttft = -1.0;
    let chunkCount = 0;
    let fullText = "";

    for await (const chunk of stream.textStream) {
      if (ttft < 0) {
        ttft = getCurrentUnixTimestamp() - start;
      }
      chunkCount++;
      fullText += chunk;
      assert.ok(chunk !== undefined);
    }

    const end = getCurrentUnixTimestamp();
    expect(chunkCount).toBeGreaterThan(0);
    expect(fullText).toMatch(/1.*2.*3.*4.*5/s);

    const spans = await backgroundLogger.drain();
    // Now we get 2 spans: streamText (parent) + doStream (child)
    expect(spans).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans.find(
      (s: any) => s.span_attributes.name === "streamText",
    ) as any;

    expect(span.span_attributes.name).toBe("streamText");
    expect(span.span_attributes.type).toBe("llm");

    const { metrics } = span;
    expect(start).toBeLessThanOrEqual(metrics.start);
    expect(metrics.start).toBeLessThanOrEqual(metrics.end);
    expect(metrics.end).toBeLessThanOrEqual(end);

    if (metrics.time_to_first_token !== undefined) {
      expect(ttft).toBeGreaterThanOrEqual(metrics.time_to_first_token);
    }

    // Token/cost metrics live on the child doStream span to avoid
    // double-counting. Parent span should NOT have them.
    expect(metrics.tokens).toBeUndefined();
    expect(metrics.prompt_tokens).toBeUndefined();
    expect(metrics.completion_tokens).toBeUndefined();

    // Verify child doStream span carries the metrics
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doStreamSpan = spans.find(
      (s: any) => s.span_attributes?.name === "doStream",
    ) as any;
    expect(doStreamSpan).toBeDefined();
    expect(doStreamSpan.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(doStreamSpan.metrics.completion_tokens).toBeGreaterThan(0);
  });

  test("ai sdk multi-turn conversation", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = openai(TEST_MODEL);
    const start = getCurrentUnixTimestamp();

    const result = await wrappedAI.generateText({
      model,
      messages: [
        {
          role: "user",
          content: "Hi, my name is Alice.",
        },
        {
          role: "assistant",
          content: "Hello Alice! Nice to meet you.",
        },
        {
          role: "user",
          content: "What did I just tell you my name was?",
        },
      ],
      maxOutputTokens: 100,
    });

    const end = getCurrentUnixTimestamp();
    assert.ok(result);
    assert.ok(result.text);
    expect(result.text.toLowerCase()).toContain("alice");

    const spans = await backgroundLogger.drain();
    // 2 spans: parent generateText + child doGenerate
    expect(spans).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(span.input.messages).toHaveLength(3);
    expect(span.input.messages[0].role).toBe("user");
    expect(span.input.messages[1].role).toBe("assistant");
    expect(span.input.messages[2].role).toBe("user");

    const { metrics } = span;
    expect(start).toBeLessThanOrEqual(metrics.start);
    expect(metrics.start).toBeLessThanOrEqual(metrics.end);
    expect(metrics.end).toBeLessThanOrEqual(end);

    // Token/cost metrics live on the child doGenerate span to avoid
    // double-counting. Parent span should NOT have them.
    expect(metrics.tokens).toBeUndefined();
    expect(metrics.prompt_tokens).toBeUndefined();
    expect(metrics.completion_tokens).toBeUndefined();

    // Verify child doGenerate span carries the metrics
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenSpan = spans.find(
      (s: any) => s.span_attributes?.name === "doGenerate",
    ) as any;
    expect(doGenSpan).toBeDefined();
    expect(doGenSpan.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(doGenSpan.metrics.completion_tokens).toBeGreaterThan(0);
  });

  test("ai sdk system prompt", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = openai(TEST_MODEL);
    const result = await wrappedAI.generateText({
      model,
      system: "You are a pirate. Always respond in pirate speak.",
      messages: [
        {
          role: "user",
          content: "Tell me about the weather.",
        },
      ],
      maxOutputTokens: 150,
    });

    assert.ok(result);
    assert.ok(result.text);

    // Check for pirate-like language
    const lowerText = result.text.toLowerCase();
    const hasPirateSpeak =
      lowerText.includes("arr") ||
      lowerText.includes("ahoy") ||
      lowerText.includes("matey") ||
      lowerText.includes("ye ") ||
      lowerText.includes("aye");

    expect(hasPirateSpeak).toBe(true);

    const spans = await backgroundLogger.drain();
    // 2 spans: parent generateText + child doGenerate
    expect(spans).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(span.input).toMatchObject({
      system: "You are a pirate. Always respond in pirate speak.",
    });
  });

  test("generateObject logs output correctly", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const recipeSchema = z.object({
      name: z.string(),
      ingredients: z.array(
        z.object({
          name: z.string(),
          amount: z.string(),
        }),
      ),
      steps: z.array(z.string()),
    });

    const result = await wrappedAI.generateObject({
      model: openai(TEST_MODEL),
      schema: recipeSchema,
      prompt: "Generate a simple recipe for toast with butter.",
    });

    expect(result.object).toBeTruthy();
    expect(result.object.name).toBeTruthy();
    expect(Array.isArray(result.object.ingredients)).toBe(true);
    expect(Array.isArray(result.object.steps)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const spans = (await backgroundLogger.drain()) as any[];
    const wrapperSpan = spans.find(
      (s) => s?.span_attributes?.name === "generateObject",
    );
    expect(wrapperSpan).toBeTruthy();
    expect(wrapperSpan.output).toBeTruthy();
    expect(wrapperSpan.output.object).toBeTruthy();
    expect(wrapperSpan.output.object.name).toBeTruthy();
    expect(Array.isArray(wrapperSpan.output.object.ingredients)).toBe(true);
    expect(Array.isArray(wrapperSpan.output.object.steps)).toBe(true);
  });

  test("generateObject logs schema in input", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const storySchema = z.object({
      title: z.string().describe("The title of the story"),
      mainCharacter: z.string().describe("The name of the main character"),
      plotPoints: z
        .array(z.string())
        .length(3)
        .describe("Three key plot points in the story"),
    });

    const result = await wrappedAI.generateObject({
      model: openai(TEST_MODEL),
      schema: storySchema,
      prompt: "Generate a short story about a robot.",
    });

    expect(result.object).toBeTruthy();
    expect(result.object.title).toBeTruthy();

    const spans = (await backgroundLogger.drain()) as any[];
    const generateObjectSpan = spans.find(
      (s) => s?.span_attributes?.name === "generateObject",
    );

    expect(generateObjectSpan).toBeTruthy();

    // Verify output contains the structured object
    expect(generateObjectSpan.output).toBeTruthy();
    expect(generateObjectSpan.output.object).toBeTruthy();
    expect(generateObjectSpan.output.object.title).toBeTruthy();

    // Verify input contains the schema (converted from Zod to JSON Schema)
    expect(generateObjectSpan.input).toBeTruthy();
    expect(generateObjectSpan.input.schema).toBeTruthy();
    expect(generateObjectSpan.input.schema.properties).toHaveProperty("title");
    expect(generateObjectSpan.input.schema.properties).toHaveProperty(
      "mainCharacter",
    );
    expect(generateObjectSpan.input.schema.properties).toHaveProperty(
      "plotPoints",
    );
    // Verify the prompt is also in input
    expect(generateObjectSpan.input.prompt).toBe(
      "Generate a short story about a robot.",
    );
  });

  test("generateText preserves span_info from Braintrust-managed prompts", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const spanInfo = {
      name: "My Custom Prompt",
      spanAttributes: { customAttr: "test-value" },
      metadata: {
        prompt: {
          id: "prompt-abc123",
          project_id: "proj-xyz789",
          version: "1.0.0",
          variables: { topic: "testing" },
        },
      },
    };

    await wrappedAI.generateText({
      model: openai(TEST_MODEL),
      prompt: "Say hello",
      span_info: spanInfo,
    } as any);

    const spans = (await backgroundLogger.drain()) as any[];
    const generateTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "My Custom Prompt",
    );

    expect(generateTextSpan).toBeTruthy();
    // Verify span name was overridden
    expect(generateTextSpan.span_attributes.name).toBe("My Custom Prompt");
    // Verify custom span attributes were merged
    expect(generateTextSpan.span_attributes.customAttr).toBe("test-value");
    // Verify prompt metadata was included
    expect(generateTextSpan.metadata.prompt).toBeTruthy();
    expect(generateTextSpan.metadata.prompt.id).toBe("prompt-abc123");
    expect(generateTextSpan.metadata.prompt.project_id).toBe("proj-xyz789");
    expect(generateTextSpan.metadata.prompt.version).toBe("1.0.0");
    expect(generateTextSpan.metadata.prompt.variables).toEqual({
      topic: "testing",
    });
    // Verify span_info is not in input (should be stripped)
    expect(generateTextSpan.input.span_info).toBeUndefined();
  });

  test("streamText preserves span_info from Braintrust-managed prompts", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const spanInfo = {
      name: "Streaming Prompt",
      metadata: {
        prompt: {
          id: "prompt-stream-123",
          project_id: "proj-stream-456",
          version: "2.0.0",
          variables: {},
        },
      },
    };

    const stream = wrappedAI.streamText({
      model: openai(TEST_MODEL),
      prompt: "Count to 3",
      span_info: spanInfo,
    } as any);

    // Consume the stream
    for await (const _ of stream.textStream) {
      // Just consume
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "Streaming Prompt",
    );

    expect(streamTextSpan).toBeTruthy();
    expect(streamTextSpan.span_attributes.name).toBe("Streaming Prompt");
    expect(streamTextSpan.metadata.prompt.id).toBe("prompt-stream-123");
    expect(streamTextSpan.metadata.prompt.project_id).toBe("proj-stream-456");
  });

  test("generateObject preserves span_info from Braintrust-managed prompts", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const spanInfo = {
      name: "Object Generation Prompt",
      metadata: {
        prompt: {
          id: "prompt-obj-789",
          project_id: "proj-obj-012",
          version: "3.0.0",
          variables: { format: "json" },
        },
      },
    };

    const schema = z.object({ greeting: z.string() });

    await wrappedAI.generateObject({
      model: openai(TEST_MODEL),
      schema,
      prompt: "Generate a greeting",
      span_info: spanInfo,
    } as any);

    const spans = (await backgroundLogger.drain()) as any[];
    const generateObjectSpan = spans.find(
      (s) => s?.span_attributes?.name === "Object Generation Prompt",
    );

    expect(generateObjectSpan).toBeTruthy();
    expect(generateObjectSpan.span_attributes.name).toBe(
      "Object Generation Prompt",
    );
    expect(generateObjectSpan.metadata.prompt.id).toBe("prompt-obj-789");
    expect(generateObjectSpan.metadata.prompt.project_id).toBe("proj-obj-012");
    // Verify schema is still in input
    expect(generateObjectSpan.input.schema).toBeTruthy();
  });

  test("streamObject preserves span_info from Braintrust-managed prompts", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const spanInfo = {
      name: "Stream Object Prompt",
      metadata: {
        prompt: {
          id: "prompt-sobj-111",
          project_id: "proj-sobj-222",
          version: "4.0.0",
          variables: {},
        },
      },
    };

    const schema = z.object({ message: z.string() });

    const stream = wrappedAI.streamObject({
      model: openai(TEST_MODEL),
      schema,
      prompt: "Stream a message",
      span_info: spanInfo,
    } as any);

    // Consume the stream
    for await (const _ of stream.partialObjectStream) {
      // Just consume
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const streamObjectSpan = spans.find(
      (s) => s?.span_attributes?.name === "Stream Object Prompt",
    );

    expect(streamObjectSpan).toBeTruthy();
    expect(streamObjectSpan.span_attributes.name).toBe("Stream Object Prompt");
    expect(streamObjectSpan.metadata.prompt.id).toBe("prompt-sobj-111");
    expect(streamObjectSpan.metadata.prompt.project_id).toBe("proj-sobj-222");
  });

  test("streamText preserves span_info when spreading a compiled prompt", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    // Simulate the object shape returned by prompt.build({ ... }, { flavor: "chat" })
    const compiledPrompt = {
      messages: [{ role: "user" as const, content: "stream text" }],
      temperature: 0.7,
      span_info: {
        name: "Stream Text Prompt",
        metadata: {
          prompt: {
            id: "prompt-compiled-abc",
            project_id: "proj-compiled-xyz",
            version: "5",
            variables: { foo: "bar" },
          },
        },
      },
    };

    const stream = wrappedAI.streamText({
      ...compiledPrompt,
      model: openai(TEST_MODEL),
    });

    for await (const _ of stream.textStream) {
      // consume
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "Stream Text Prompt",
    );

    expect(streamTextSpan).toBeTruthy();
    expect(streamTextSpan.metadata.prompt).toBeTruthy();
    expect(streamTextSpan.metadata.prompt.id).toBe("prompt-compiled-abc");
    expect(streamTextSpan.metadata.prompt.project_id).toBe("proj-compiled-xyz");
    expect(streamTextSpan.metadata.prompt.version).toBe("5");
    expect(streamTextSpan.metadata.prompt.variables).toEqual({ foo: "bar" });
  });

  test("streamObject toTextStreamResponse", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const simpleSchema = z.object({ answer: z.string() });
    const streamRes = await wrappedAI.streamObject({
      model: openai(TEST_MODEL),
      schema: simpleSchema,
      prompt: "Stream a JSON object with key 'answer' set to 'ok'.",
    });

    const response = streamRes.toTextStreamResponse();
    expect(response).toBeInstanceOf(Response);
    expect(response.body).toBeTruthy();

    if (response.body) {
      const reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const fullText = chunks.join("");
      expect(fullText.length).toBeGreaterThan(0);
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const spans = (await backgroundLogger.drain()) as any[];
    const wrapperSpan = spans.find(
      (s) =>
        s?.span_attributes?.name === "streamObject" &&
        s?.output &&
        typeof s.output === "object",
    );
    expect(wrapperSpan).toBeTruthy();
    expect(typeof wrapperSpan.metrics?.time_to_first_token).toBe("number");
  });

  test("streamObject logs object in output correctly", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const recipeSchema = z.object({
      name: z.string(),
      ingredients: z.array(
        z.object({
          name: z.string(),
          amount: z.string(),
        }),
      ),
      steps: z.array(z.string()),
    });

    const streamRes = await wrappedAI.streamObject({
      model: openai(TEST_MODEL),
      schema: recipeSchema,
      prompt: "Generate a simple recipe for toast with butter.",
    });

    for await (const _ of streamRes.partialObjectStream) {
    }

    const finalObject = await streamRes.object;
    expect(finalObject).toBeTruthy();
    expect(finalObject.name).toBeTruthy();
    expect(Array.isArray(finalObject.ingredients)).toBe(true);
    expect(Array.isArray(finalObject.steps)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const spans = (await backgroundLogger.drain()) as any[];
    const wrapperSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamObject",
    );
    expect(wrapperSpan).toBeTruthy();
    expect(wrapperSpan.output).toBeTruthy();
    expect(wrapperSpan.output.object).toBeTruthy();
    expect(wrapperSpan.output.object.name).toBeTruthy();
    expect(Array.isArray(wrapperSpan.output.object.ingredients)).toBe(true);
    expect(Array.isArray(wrapperSpan.output.object.steps)).toBe(true);
  });

  test("doStream captures JSON content for streamObject", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const simpleSchema = z.object({
      answer: z.string(),
    });

    const streamRes = await wrappedAI.streamObject({
      model: openai(TEST_MODEL),
      schema: simpleSchema,
      prompt: "What is 2+2? Answer with just the number.",
    });

    for await (const _ of streamRes.partialObjectStream) {
    }

    const finalObject = await streamRes.object;
    expect(finalObject).toBeTruthy();
    expect(finalObject.answer).toBeTruthy();

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const spans = (await backgroundLogger.drain()) as any[];

    // Find the doStream span (child of streamObject)
    const doStreamSpan = spans.find(
      (s) =>
        s?.span_attributes?.name === "doStream" &&
        s?.span_attributes?.type === "llm",
    );

    // doStream span should exist and have output
    expect(doStreamSpan).toBeTruthy();
    expect(doStreamSpan.output).toBeDefined();

    // For structured output, the text should contain the JSON response
    // v5: finishReason is "stop", v6: finishReason is { unified: "stop" }
    expect(doStreamSpan.output.finishReason).toBeDefined();
    expect(doStreamSpan.output.usage).toBeDefined();

    // The text should contain the JSON object (may be empty for some providers)
    // At minimum, verify the output structure is correct
    expect(typeof doStreamSpan.output.text).toBe("string");
    expect(Array.isArray(doStreamSpan.output.toolCalls)).toBe(true);
  });

  test("streamText returns correct type with toUIMessageStreamResponse", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const result = wrappedAI.streamText({
      model: openai(TEST_MODEL),
      prompt: "Say hello in one sentence.",
    });

    // Verify result is not a Promise (synchronous return)
    expect(result).not.toBeInstanceOf(Promise);

    // Verify toUIMessageStreamResponse method exists
    expect(typeof result.toUIMessageStreamResponse).toBe("function");

    // Verify it can be called
    const response = result.toUIMessageStreamResponse();
    expect(response).toBeInstanceOf(Response);
    expect(response.body).toBeTruthy();

    // Consume the stream to trigger logging
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Wait for the stream to fully finish and onFinish callback to complete
    await result.text;

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const spans = (await backgroundLogger.drain()) as any[];
    const wrapperSpan = spans.find(
      (s) =>
        s?.span_attributes?.name === "streamText" &&
        s?.output &&
        typeof s.output === "object" &&
        typeof s.output.text === "string",
    );
    expect(wrapperSpan).toBeTruthy();
  });

  test("streamText supports async iteration over textStream", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const result = wrappedAI.streamText({
      model: openai(TEST_MODEL),
      prompt: "Invent a new holiday and describe its traditions.",
    });

    // Verify result is not a Promise (synchronous return)
    expect(result).not.toBeInstanceOf(Promise);

    // Verify textStream property exists
    expect(result.textStream).toBeTruthy();

    // Consume the stream using async iteration
    let fullText = "";
    for await (const textPart of result.textStream) {
      fullText += textPart;
    }

    // Verify we got some text
    expect(fullText.length).toBeGreaterThan(0);

    // Wait for the stream to fully finish and onFinish callback to complete
    await result.text;

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const spans = (await backgroundLogger.drain()) as any[];
    const wrapperSpan = spans.find(
      (s) =>
        s?.span_attributes?.name === "streamText" &&
        s?.output &&
        typeof s.output === "object" &&
        typeof s.output.text === "string",
    );
    expect(wrapperSpan).toBeTruthy();
    expect(wrapperSpan.output.text).toBe(fullText);
  });

  test("omit function respects path specificity", () => {
    // Test that paths only omit specific nested properties
    const testObj = {
      body: "This should NOT be omitted",
      response: {
        body: "This SHOULD be omitted",
        headers: {
          "content-type": "application/json",
        },
        status: 200,
      },
      request: {
        body: "This SHOULD be omitted",
        method: "POST",
        url: "https://api.example.com",
      },
      text: "Some text content",
      metadata: {
        model: "gpt-4",
      },
    };

    const paths = ["request.body", "response.body"];
    const result = omit(testObj, paths);

    // Root-level body should NOT be omitted
    expect(result.body).toBe("This should NOT be omitted");

    // response.body SHOULD be omitted
    expect(result.response.body).toBe("<omitted>");

    // request.body SHOULD be omitted
    expect(result.request.body).toBe("<omitted>");

    // Other properties should remain unchanged
    expect(result.response.headers).toEqual({
      "content-type": "application/json",
    });
    expect(result.response.status).toBe(200);
    expect(result.request.method).toBe("POST");
    expect(result.request.url).toBe("https://api.example.com");
    expect(result.text).toBe("Some text content");
    expect(result.metadata.model).toBe("gpt-4");
  });

  test("omit function handles non-existent paths", () => {
    const testObj = {
      a: {
        b: "value",
      },
      c: "another value",
    };

    const paths = ["a.b.c.d", "x.y.z", "a.nonexistent"];
    const result = omit(testObj, paths);

    // Non-existent paths should not affect the output
    expect(result).toEqual({
      a: {
        b: "value",
      },
      c: "another value",
    });

    // Test with a fully non-existent deep path
    const testObj2 = {
      a: "value",
    };
    const result2 = omit(testObj2, ["b.c.d"]);
    expect(result2).toEqual({
      a: "value",
    });
  });

  test("omit function handles partial paths correctly", () => {
    // Test that paths are only omitted when they fully exist
    const testObj = {
      request: {
        method: "POST",
        url: "https://api.example.com",
        // Note: no 'body' property
      },
      response: {
        status: 200,
        body: {
          data: "some data",
        },
      },
      metadata: {
        model: "gpt-4",
      },
    };

    const paths = ["request.body", "response.body"];
    const result = omit(testObj, paths);

    // request.body doesn't exist, so request should be unchanged
    expect(result.request).toEqual({
      method: "POST",
      url: "https://api.example.com",
    });

    // response.body exists and should be omitted
    expect(result.response.body).toBe("<omitted>");
    expect(result.response.status).toBe(200);

    // Other properties should remain unchanged
    expect(result.metadata).toEqual({
      model: "gpt-4",
    });
  });

  test("omit function handles root-level primitives", () => {
    const obj = { a: { b: 2 }, c: 3, d: 4 };
    const result = omit(obj, ["a.b", "c"]);

    expect(result).toEqual({
      a: { b: "<omitted>" },
      c: "<omitted>",
      d: 4,
    });
  });

  test("omit function handles arrays", () => {
    const testObj = {
      items: [1, 2, 3],
      nested: {
        arr: ["a", "b", "c"],
      },
    };

    const result = omit(testObj, ["items", "nested.arr"]);

    expect(result.items).toBe("<omitted>");
    expect(result.nested.arr).toBe("<omitted>");
  });

  test("omit function handles empty paths array", () => {
    const testObj = { a: 1, b: 2 };
    const result = omit(testObj, []);

    expect(result).toEqual({ a: 1, b: 2 });
  });

  test("omit function handles single-key paths", () => {
    const testObj = {
      key1: "value1",
      key2: { nested: "value2" },
      key3: "value3",
    };

    const result = omit(testObj, ["key1", "key3"]);

    expect(result.key1).toBe("<omitted>");
    expect(result.key2).toEqual({ nested: "value2" });
    expect(result.key3).toBe("<omitted>");
  });

  test("omit function handles mixed primitives and objects", () => {
    const testObj = {
      string: "text",
      number: 42,
      boolean: true,
      nullValue: null,
      obj: { nested: "value" },
      arr: [1, 2, 3],
    };

    const result = omit(testObj, [
      "string",
      "number",
      "boolean",
      "nullValue",
      "obj.nested",
    ]);

    expect(result.string).toBe("<omitted>");
    expect(result.number).toBe("<omitted>");
    expect(result.boolean).toBe("<omitted>");
    expect(result.nullValue).toBe("<omitted>");
    expect(result.obj.nested).toBe("<omitted>");
    expect(result.arr).toEqual([1, 2, 3]);
  });

  test("omit function handles array wildcards", () => {
    const testObj = {
      a: [{ b: 1 }, { b: 2 }, { b: 3 }],
    };

    const result = omit(testObj, ["a[].b"]);

    expect(result.a).toEqual([
      { b: "<omitted>" },
      { b: "<omitted>" },
      { b: "<omitted>" },
    ]);
  });

  test("omit function handles array indices", () => {
    const testObj = {
      a: [{ b: 1 }, { b: 2 }, { b: 3 }],
    };

    const result = omit(testObj, ["a[0].b", "a[2].b"]);

    expect(result.a).toEqual([
      { b: "<omitted>" },
      { b: 2 },
      { b: "<omitted>" },
    ]);
  });

  test("omit function handles mixed bracket and dot notation", () => {
    const testObj = {
      users: [
        { name: "Alice", settings: { theme: "dark" } },
        { name: "Bob", settings: { theme: "light" } },
      ],
    };

    const result = omit(testObj, ["users[].settings.theme"]);

    expect(result.users).toEqual([
      { name: "Alice", settings: { theme: "<omitted>" } },
      { name: "Bob", settings: { theme: "<omitted>" } },
    ]);
  });

  test("omit function handles nested array wildcards", () => {
    const testObj = {
      data: [
        { items: [{ value: 1 }, { value: 2 }] },
        { items: [{ value: 3 }, { value: 4 }] },
      ],
    };

    const result = omit(testObj, ["data[].items[].value"]);

    expect(result.data).toEqual([
      { items: [{ value: "<omitted>" }, { value: "<omitted>" }] },
      { items: [{ value: "<omitted>" }, { value: "<omitted>" }] },
    ]);
  });

  test("ai sdk tool execution with input/output", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const calculateTool = ai.tool({
      description: "Perform a mathematical calculation",
      inputSchema: z.object({
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      }),
      execute: async (args: {
        operation: "add" | "subtract" | "multiply" | "divide";
        a: number;
        b: number;
      }) => {
        switch (args.operation) {
          case "add":
            return String(args.a + args.b);
          case "subtract":
            return String(args.a - args.b);
          case "multiply":
            return String(args.a * args.b);
          case "divide":
            return args.b !== 0 ? String(args.a / args.b) : "0";
          default:
            return "0";
        }
      },
    });

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      tools: {
        calculate: calculateTool,
      },
      prompt: "What is 25 plus 17? Use the calculate tool.",
      stopWhen: ai.stepCountIs(2),
    });

    assert.ok(result);
    // Note: result.text may be empty if only tool calls were made without follow-up

    const spans = await backgroundLogger.drain();

    // Should have at least 2 spans: the main generateText span and the tool execution span
    expect(spans.length).toBeGreaterThanOrEqual(2);

    // Find the tool execution span
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const toolSpan = spans.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (span: any) =>
        span.span_attributes?.type === "tool" &&
        span.span_attributes?.name === "calculate",
    );

    expect(toolSpan).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const toolSpanTyped = toolSpan as any;

    // Verify the tool span has the correct structure
    expect(toolSpanTyped).toMatchObject({
      span_attributes: {
        type: "tool",
        name: "calculate",
      },
    });

    // Verify input is captured
    expect(toolSpanTyped.input).toBeDefined();
    // Input can be an array if multiple args are passed, check the first element
    const inputData = Array.isArray(toolSpanTyped.input)
      ? toolSpanTyped.input[0]
      : toolSpanTyped.input;
    expect(inputData).toMatchObject({
      operation: "add",
      a: 25,
      b: 17,
    });

    // Verify output is captured
    expect(toolSpanTyped.output).toBeDefined();
    expect(toolSpanTyped.output).toBe("42");
  });

  test("ai sdk Agent class can be extended", async () => {
    // Skip if Agent is not available in this version of ai SDK
    // Note: v5/v6 use Experimental_Agent (capital E)
    if (!wrappedAI.Agent && !wrappedAI.Experimental_Agent) {
      console.log("Skipping Agent extension test - Agent not available");
      return;
    }

    const AgentClass = wrappedAI.Agent || wrappedAI.Experimental_Agent;
    const model = openai(TEST_MODEL);

    // Create a custom Agent subclass
    class CustomAgent extends AgentClass {
      customMethod() {
        return "custom";
      }
    }

    const agent = new CustomAgent({
      model,
      system: "You are a helpful assistant.",
    });

    // Verify it's actually an instance of CustomAgent
    expect(agent).toBeInstanceOf(CustomAgent);
    expect(agent.customMethod()).toBe("custom");

    // Verify the wrapped methods still work
    const result = await agent.generate({
      messages: [
        {
          role: "user",
          content: "Say 'hello'",
        },
      ],
      maxTokens: 50,
    });

    expect(result.text).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");

    // Verify tracing still works with proper span structure
    const spans = await backgroundLogger.drain();
    expect(spans.length).toBeGreaterThanOrEqual(1);

    const span = spans[0];

    // Assert on span structure
    expect(span.project_id).toBeDefined();
    expect(span.log_id).toBe("g");
    expect(span.created).toBeDefined();
    expect(span.span_id).toBeDefined();
    expect(span.root_span_id).toBeDefined();
    expect(span.span_attributes).toMatchObject({
      type: "llm",
      name: "CustomAgent.generate",
    });
    expect(span.metadata).toMatchObject({
      model: TEST_MODEL,
    });
    expect(span.input).toMatchObject({
      messages: [
        {
          role: "user",
          content: "Say 'hello'",
        },
      ],
    });
    expect(span.metrics).toBeDefined();
    expect(span.metrics.start).toBeDefined();
    expect(span.metrics.end).toBeDefined();
  });

  // TODO: Add test for ToolLoopAgent with Output.object() schema serialization
  // Currently the output field is not properly serialized - it shows as output: {}
  // because the responseFormat is a Promise that needs to be awaited.
  // Once processInputAttachments is made async and properly handles the Promise,
  // we should verify that the schema is serialized correctly in the logs.

  test("ai sdk multi-round tool use with metrics", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const getStorePriceTool = ai.tool({
      description: "Get the price of an item from a specific store",
      inputSchema: z.object({
        store: z.string().describe("The store name (e.g., 'StoreA', 'StoreB')"),
        item: z.string().describe("The item to get the price for"),
      }),
      execute: async (args: { store: string; item: string }) => {
        const prices: Record<string, Record<string, number>> = {
          StoreA: { laptop: 999, mouse: 25, keyboard: 75 },
          StoreB: { laptop: 1099, mouse: 20, keyboard: 80 },
        };
        const price = prices[args.store]?.[args.item] ?? 0;
        return JSON.stringify({ store: args.store, item: args.item, price });
      },
    });

    const applyDiscountTool = ai.tool({
      description: "Apply a discount code to a total amount",
      inputSchema: z.object({
        total: z.number().describe("The total amount before discount"),
        discountCode: z.string().describe("The discount code to apply"),
      }),
      execute: async (args: { total: number; discountCode: string }) => {
        const discounts: Record<string, number> = {
          SAVE10: 0.1,
          SAVE20: 0.2,
        };
        const discountRate = discounts[args.discountCode] ?? 0;
        const finalTotal = args.total - args.total * discountRate;
        return JSON.stringify({
          originalTotal: args.total,
          discountCode: args.discountCode,
          finalTotal,
        });
      },
    });

    const model = openai(TEST_MODEL);
    const start = getCurrentUnixTimestamp();

    const result = await wrappedAI.generateText({
      model,
      system:
        "You are a shopping assistant. When asked about prices, always get the price from each store mentioned using get_store_price, then apply any discount codes using apply_discount. Use the tools provided.",
      tools: {
        get_store_price: getStorePriceTool,
        apply_discount: applyDiscountTool,
      },
      toolChoice: "required",
      prompt:
        "I want to buy a laptop. Get the price from StoreA and StoreB, then apply the discount code SAVE20 to whichever is cheaper.",
      stopWhen: ai.stepCountIs(6),
    });

    const end = getCurrentUnixTimestamp();
    assert.ok(result);

    const spans = await backgroundLogger.drain();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llmSpans = spans.filter(
      (s: any) =>
        s.span_attributes?.type === "llm" &&
        s.span_attributes?.name === "doGenerate",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpans = spans.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.span_attributes?.type === "tool",
    );

    // Should have multiple doGenerate spans - one per LLM round/step
    // This allows visualizing the LLM ↔ tool roundtrips
    expect(llmSpans.length).toBeGreaterThanOrEqual(2);

    // Should have tool spans for get_store_price calls (at least 2 for StoreA and StoreB)
    expect(toolSpans.length).toBeGreaterThanOrEqual(2);

    // Verify each doGenerate span has its own metrics
    for (const llmSpan of llmSpans) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const span = llmSpan as any;
      expect(span.metrics).toBeDefined();
      expect(span.metrics.start).toBeDefined();
      expect(span.metrics.end).toBeDefined();
      expect(start).toBeLessThanOrEqual(span.metrics.start);
      expect(span.metrics.end).toBeLessThanOrEqual(end);

      // Token metrics structure varies by AI SDK version
      // v5: metrics.tokens, prompt_tokens, completion_tokens are defined
      // v6: metrics structure may differ - see v5-specific tests for strict assertions
    }

    // Verify tool spans have the expected structure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storePriceSpans = toolSpans.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.span_attributes?.name === "get_store_price",
    );
    expect(storePriceSpans.length).toBeGreaterThanOrEqual(2);

    // Verify tool spans have input/output
    for (const toolSpan of storePriceSpans) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const span = toolSpan as any;
      expect(span.input).toBeDefined();
      expect(span.output).toBeDefined();

      const inputData = Array.isArray(span.input) ? span.input[0] : span.input;
      expect(inputData.store).toMatch(/^Store[AB]$/);
      expect(inputData.item).toBe("laptop");
    }
  });

  test("ai sdk multi-round tool use span hierarchy", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const stepOneTool = ai.tool({
      description: "First step tool that returns a number",
      inputSchema: z.object({
        input: z.string(),
      }),
      execute: async () => "42",
    });

    const stepTwoTool = ai.tool({
      description: "Second step tool that uses the result from step one",
      inputSchema: z.object({
        value: z.number(),
      }),
      execute: async (args: { value: number }) => String(args.value * 2),
    });

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      system:
        "You must use the tools in sequence. First call step_one to get a number, then call step_two with that number.",
      tools: {
        step_one: stepOneTool,
        step_two: stepTwoTool,
      },
      toolChoice: "required",
      prompt:
        "Execute the two-step process: first get a number, then double it.",
      stopWhen: ai.stepCountIs(5),
    });

    assert.ok(result);

    const spans = await backgroundLogger.drain();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llmSpans = spans.filter(
      (s: any) =>
        s.span_attributes?.type === "llm" &&
        s.span_attributes?.name === "doGenerate",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpans = spans.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.span_attributes?.type === "tool",
    );

    // Should have multiple doGenerate spans (one per LLM call)
    expect(llmSpans.length).toBeGreaterThanOrEqual(2);

    // Should have at least 1 tool span (step_one)
    expect(toolSpans.length).toBeGreaterThanOrEqual(1);

    // Verify spans have root_span_id linking them together
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootSpanIds = new Set(spans.map((s: any) => s.root_span_id));
    // All spans should share the same root (they're part of the same generateText call)
    expect(rootSpanIds.size).toBe(1);

    // Verify step_one tool was called
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stepOneSpan = toolSpans.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.span_attributes?.name === "step_one",
    );
    expect(stepOneSpan).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((stepOneSpan as any).output).toBe("42");
  });

  test("ai sdk parallel tool calls in single round", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    let toolACalls = 0;
    let toolBCalls = 0;

    const toolA = ai.tool({
      description: "Tool A - gets value A",
      inputSchema: z.object({ id: z.string() }),
      execute: async () => {
        toolACalls++;
        return "value_a";
      },
    });

    const toolB = ai.tool({
      description: "Tool B - gets value B",
      inputSchema: z.object({ id: z.string() }),
      execute: async () => {
        toolBCalls++;
        return "value_b";
      },
    });

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      system:
        "When asked to get both values, you MUST call both tool_a and tool_b in parallel in the same response.",
      tools: {
        tool_a: toolA,
        tool_b: toolB,
      },
      toolChoice: "required",
      prompt:
        'Get both value A (id: "1") and value B (id: "2") at the same time.',
      stopWhen: ai.stepCountIs(4),
    });

    assert.ok(result);

    const spans = await backgroundLogger.drain();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpans = spans.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.span_attributes?.type === "tool",
    );

    // Both tools should have been called
    expect(toolACalls).toBeGreaterThanOrEqual(1);
    expect(toolBCalls).toBeGreaterThanOrEqual(1);

    // Should have tool spans for both
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolASpan = toolSpans.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.span_attributes?.name === "tool_a",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolBSpan = toolSpans.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.span_attributes?.name === "tool_b",
    );

    expect(toolASpan).toBeDefined();
    expect(toolBSpan).toBeDefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((toolASpan as any).output).toBe("value_a");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((toolBSpan as any).output).toBe("value_b");

    // Both tool spans should share the same root
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((toolASpan as any).root_span_id).toBe(
      (toolBSpan as any).root_span_id,
    );
  });

  test("ai sdk async generator tool execution", async () => {
    // Test for GitHub issue #1134: async generator tools should work correctly
    // AI SDK v5 supports tools with async generator execute functions that yield
    // intermediate status updates
    expect(await backgroundLogger.drain()).toHaveLength(0);

    // Track status updates - use a fresh array each time to handle test retries
    const statusUpdates: string[] = [];

    const streamingTool = ai.tool({
      description: "A tool that streams status updates",
      inputSchema: z.object({
        name: z.string().describe("The name to greet"),
      }),
      execute: async function* (args: { name: string }) {
        statusUpdates.push("starting");
        yield { status: "starting", message: "Preparing greeting..." };

        statusUpdates.push("processing");
        yield { status: "processing", message: `Looking up ${args.name}...` };

        statusUpdates.push("done");
        yield { status: "done", greeting: `Hello, ${args.name}!` };
      },
    });

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      tools: {
        greeting: streamingTool,
      },
      toolChoice: "required",
      prompt: "Please use the greeting tool to greet someone named World",
      stopWhen: ai.stepCountIs(1),
    });

    assert.ok(result);

    // Verify that the async generator was actually iterated (exactly once with 3 yields)
    expect(statusUpdates).toEqual(["starting", "processing", "done"]);

    const spans = await backgroundLogger.drain();

    // Find the tool execution span
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpan = spans.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (span: any) =>
        span.span_attributes?.type === "tool" &&
        span.span_attributes?.name === "greeting",
    );

    expect(toolSpan).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpanTyped = toolSpan as any;

    // Verify the tool span has the correct structure
    expect(toolSpanTyped).toMatchObject({
      span_attributes: {
        type: "tool",
        name: "greeting",
      },
    });

    // Verify input is captured
    expect(toolSpanTyped.input).toBeDefined();
    const inputData = Array.isArray(toolSpanTyped.input)
      ? toolSpanTyped.input[0]
      : toolSpanTyped.input;
    expect(inputData).toMatchObject({
      name: "World",
    });

    // Verify output is captured (should be the final yielded value, not {})
    expect(toolSpanTyped.output).toBeDefined();
    expect(toolSpanTyped.output).not.toEqual({});
    expect(toolSpanTyped.output).toMatchObject({
      status: "done",
      greeting: "Hello, World!",
    });
  });

  test("metadata.tools is in ToolFunctionDefinition format", async () => {
    // Test that metadata.tools follows the ToolFunctionDefinition schema:
    // { type: "function", function: { name, description?, parameters?, strict? } }
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const calculatorTool = {
      description: "Perform a calculation",
      inputSchema: z.object({
        operation: z.enum(["add", "subtract"]),
        a: z.number(),
        b: z.number(),
      }),
      execute: async (args: { operation: string; a: number; b: number }) => {
        return args.operation === "add"
          ? String(args.a + args.b)
          : String(args.a - args.b);
      },
    };

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      tools: {
        calculator: calculatorTool,
      },
      toolChoice: "required",
      prompt: "Use the calculator to add 5 and 3",
      stopWhen: ai.stepCountIs(1),
    });

    assert.ok(result);

    const spans = await backgroundLogger.drain();

    // Find the generateText root span
    const generateTextSpan = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(generateTextSpan).toBeDefined();
    expect(generateTextSpan.metadata.tools).toBeDefined();
    expect(Array.isArray(generateTextSpan.metadata.tools)).toBe(true);
    expect(generateTextSpan.metadata.tools).toHaveLength(1);

    // Verify ToolFunctionDefinition format
    const toolDef = generateTextSpan.metadata.tools[0];
    expect(toolDef.type).toBe("function");
    expect(toolDef.function).toBeDefined();
    expect(toolDef.function.name).toBe("calculator");
    expect(toolDef.function.description).toBe("Perform a calculation");
    expect(toolDef.function.parameters).toBeDefined();
    expect(toolDef.function.parameters.type).toBe("object");
    expect(toolDef.function.parameters.properties).toBeDefined();
    expect(toolDef.function.parameters.properties.operation).toBeDefined();
    expect(toolDef.function.parameters.properties.a).toBeDefined();
    expect(toolDef.function.parameters.properties.b).toBeDefined();

    // Find doGenerate child span - should also have tools in metadata
    const doGenerateSpan = spans.find(
      (s: any) => s.span_attributes?.name === "doGenerate",
    ) as any;

    expect(doGenerateSpan).toBeDefined();
    expect(doGenerateSpan.metadata.tools).toBeDefined();
    expect(Array.isArray(doGenerateSpan.metadata.tools)).toBe(true);

    // Verify child span also has ToolFunctionDefinition format
    const childToolDef = doGenerateSpan.metadata.tools[0];
    expect(childToolDef.type).toBe("function");
    expect(childToolDef.function.name).toBe("calculator");
  });

  test("metadata.tools is not set when no tools are used", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      prompt: "Say hello",
      maxOutputTokens: 50,
    });

    assert.ok(result);

    const spans = await backgroundLogger.drain();

    const generateTextSpan = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(generateTextSpan).toBeDefined();
    // metadata.tools should not be set (not even an empty array)
    expect(generateTextSpan.metadata.tools).toBeUndefined();
  });

  test("ai sdk string model ID resolution with per-step spans", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    // Set up the global provider so string model IDs can be resolved
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openaiProvider = createOpenAI({});
    (globalThis as any).AI_SDK_DEFAULT_PROVIDER = openaiProvider;

    const simpleTool = ai.tool({
      description: "A simple tool that echoes input",
      inputSchema: z.object({ message: z.string() }),
      execute: async (args: { message: string }) => `Echo: ${args.message}`,
    });

    // Use string model ID instead of openai("gpt-4o-mini")
    const result = await wrappedAI.generateText({
      model: "gpt-4o-mini",
      tools: { echo: simpleTool },
      toolChoice: "required",
      prompt: "Use the echo tool with message 'hello'",
      stopWhen: ai.stepCountIs(4),
    });

    // Clean up global provider
    delete (globalThis as any).AI_SDK_DEFAULT_PROVIDER;

    assert.ok(result);

    const spans = await backgroundLogger.drain();

    // Should have parent generateText span + doGenerate spans + tool spans
    expect(spans.length).toBeGreaterThanOrEqual(2);

    // Verify we have doGenerate spans (per-step LLM calls)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenerateSpans = spans.filter(
      (s: any) =>
        s.span_attributes?.type === "llm" &&
        s.span_attributes?.name === "doGenerate",
    );
    expect(doGenerateSpans.length).toBeGreaterThanOrEqual(1);

    // Verify doGenerate span has proper metadata from resolved model
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstDoGenerate = doGenerateSpans[0] as any;
    expect(firstDoGenerate.metadata).toBeDefined();
    expect(firstDoGenerate.metadata.model).toBe("gpt-4o-mini");
    expect(firstDoGenerate.metadata.provider).toMatch(/openai/);

    // Verify metrics are captured (structure varies by AI SDK version)
    expect(firstDoGenerate.metrics).toBeDefined();
  });

  test("doGenerate captures input and output correctly", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const { createOpenAI } = await import("@ai-sdk/openai");
    const openaiProvider = createOpenAI({});
    (globalThis as any).AI_SDK_DEFAULT_PROVIDER = openaiProvider;

    const result = await wrappedAI.generateText({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: "Say hello",
        },
      ],
      maxOutputTokens: 50,
    });

    delete (globalThis as any).AI_SDK_DEFAULT_PROVIDER;

    assert.ok(result);
    expect(result.text).toBeTruthy();

    const spans = await backgroundLogger.drain();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenerateSpans = spans.filter(
      (s: any) =>
        s.span_attributes?.type === "llm" &&
        s.span_attributes?.name === "doGenerate",
    );
    expect(doGenerateSpans.length).toBeGreaterThanOrEqual(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenSpan = doGenerateSpans[0] as any;

    // Verify input is captured (should have prompt array from LanguageModelV1CallOptions)
    expect(doGenSpan.input).toBeDefined();
    expect(doGenSpan.input.prompt).toBeDefined();
    expect(Array.isArray(doGenSpan.input.prompt)).toBe(true);

    // Verify output is captured (doGenerate returns content array, not text directly)
    expect(doGenSpan.output).toBeDefined();
    expect(doGenSpan.output.content).toBeDefined();
    expect(Array.isArray(doGenSpan.output.content)).toBe(true);
    expect(doGenSpan.output.content[0].text).toBeDefined();
    expect(doGenSpan.output.finishReason).toBeDefined();

    // Verify metadata has braintrust integration info
    expect(doGenSpan.metadata.braintrust).toBeDefined();
    expect(doGenSpan.metadata.braintrust.integration_name).toBe("ai-sdk");
    expect(doGenSpan.metadata.braintrust.sdk_language).toBe("typescript");

    // Verify finish_reason is captured in metadata
    expect(doGenSpan.metadata.finish_reason).toBeDefined();

    // Verify metrics
    expect(doGenSpan.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(doGenSpan.metrics.completion_tokens).toBeGreaterThan(0);
  });

  test("doGenerate processes image attachments in prompt array", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const imageBuffer = readFileSync(join(FIXTURES_DIR, "test-image.png"));

    const { createOpenAI } = await import("@ai-sdk/openai");
    const openaiProvider = createOpenAI({});
    (globalThis as any).AI_SDK_DEFAULT_PROVIDER = openaiProvider;

    const result = await wrappedAI.generateText({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: imageBuffer,
              mimeType: "image/png",
            },
            { type: "text", text: "What color is this image?" },
          ],
        },
      ],
      maxOutputTokens: 100,
    });

    delete (globalThis as any).AI_SDK_DEFAULT_PROVIDER;

    assert.ok(result);
    expect(result.text).toBeTruthy();

    const spans = await backgroundLogger.drain();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenerateSpans = spans.filter(
      (s: any) =>
        s.span_attributes?.type === "llm" &&
        s.span_attributes?.name === "doGenerate",
    );
    expect(doGenerateSpans.length).toBeGreaterThanOrEqual(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doGenSpan = doGenerateSpans[0] as any;

    // Verify input has prompt array (provider-level format)
    expect(doGenSpan.input).toBeDefined();
    expect(doGenSpan.input.prompt).toBeDefined();
    expect(Array.isArray(doGenSpan.input.prompt)).toBe(true);
    expect(doGenSpan.input.prompt.length).toBeGreaterThan(0);

    // Find the user message in the prompt array
    const userMessage = doGenSpan.input.prompt.find(
      (m: any) => m.role === "user",
    );
    expect(userMessage).toBeDefined();
    expect(Array.isArray(userMessage.content)).toBe(true);

    // Find the file content part (AI SDK converts image to file at provider level)
    const fileContent = userMessage.content.find((c: any) => c.type === "file");
    expect(fileContent).toBeDefined();

    // Verify image was converted to a braintrust attachment
    // At provider level, the attachment is in data.reference
    if (fileContent && fileContent.data) {
      expect(fileContent.data.reference).toMatchObject({
        type: "braintrust_attachment",
        key: expect.any(String),
        content_type: "image/png",
      });
    }
  });

  test("doStream captures input and accumulated output correctly", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const { createOpenAI } = await import("@ai-sdk/openai");
    const openaiProvider = createOpenAI({});
    (globalThis as any).AI_SDK_DEFAULT_PROVIDER = openaiProvider;

    const stream = await wrappedAI.streamText({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: "Count from 1 to 3.",
        },
      ],
      maxOutputTokens: 50,
    });

    let fullText = "";
    for await (const chunk of stream.textStream) {
      fullText += chunk;
    }

    delete (globalThis as any).AI_SDK_DEFAULT_PROVIDER;

    expect(fullText).toMatch(/1.*2.*3/s);

    const spans = await backgroundLogger.drain();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doStreamSpans = spans.filter(
      (s: any) =>
        s.span_attributes?.type === "llm" &&
        s.span_attributes?.name === "doStream",
    );
    expect(doStreamSpans.length).toBeGreaterThanOrEqual(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doStreamSpan = doStreamSpans[0] as any;

    // Verify input is captured
    expect(doStreamSpan.input).toBeDefined();
    expect(doStreamSpan.input.prompt).toBeDefined();
    expect(Array.isArray(doStreamSpan.input.prompt)).toBe(true);

    // Verify output structure (text may be empty if provider doesn't emit text-delta chunks)
    expect(doStreamSpan.output).toBeDefined();
    expect(typeof doStreamSpan.output.text).toBe("string");
    expect(doStreamSpan.output.text).not.toContain("undefined");
    // v5: finishReason is "stop", v6: finishReason is { unified: "stop" }
    expect(doStreamSpan.output.finishReason).toBeDefined();
    expect(doStreamSpan.output.usage).toBeDefined();

    // Verify metadata has braintrust integration info
    expect(doStreamSpan.metadata.braintrust).toBeDefined();
    expect(doStreamSpan.metadata.braintrust.integration_name).toBe("ai-sdk");
    expect(doStreamSpan.metadata.braintrust.sdk_language).toBe("typescript");

    // Verify finish_reason is captured in metadata
    expect(doStreamSpan.metadata.finish_reason).toBeDefined();

    // Verify metrics including time_to_first_token
    expect(doStreamSpan.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(doStreamSpan.metrics.completion_tokens).toBeGreaterThan(0);
    expect(doStreamSpan.metrics.time_to_first_token).toBeGreaterThan(0);
    expect(typeof doStreamSpan.metrics.time_to_first_token).toBe("number");
  });

  test("streamText with Output.object logs schema correctly", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const schema = z.object({
      scratchpad: z.string().describe("A scratchpad for notes"),
      answer: z.string().describe("The final answer"),
    });

    const outputSchema = ai.Output.object({
      schema,
    });

    const model = openai(TEST_MODEL);

    const stream = wrappedAI.streamText({
      model,
      output: outputSchema,
      messages: [
        {
          role: "user",
          content: "What is 2+2? Think step by step in scratchpad.",
        },
      ],
      maxOutputTokens: 200,
    });

    let fullText = "";
    for await (const chunk of stream.textStream) {
      fullText += chunk;
    }

    await stream.text;

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamText",
    );

    expect(streamTextSpan).toBeTruthy();

    // Verify input contains the output schema
    expect(streamTextSpan.input).toBeTruthy();
    expect(streamTextSpan.input.output).toBeTruthy();

    console.log({
      response_format: streamTextSpan.input.output.response_format,
    });

    // The schema should be serialized with response_format containing the schema
    // Note: The AI SDK may transform the output object, so we check for response_format
    // which is set by our serialization, not the original responseFormat
    expect(streamTextSpan.input.output.response_format).toBeTruthy();
    // response_format should have type "json" and the schema
    expect(streamTextSpan.input.output.response_format.type).toBe("json");
    expect(streamTextSpan.input.output.response_format.schema).toBeTruthy();
    expect(
      streamTextSpan.input.output.response_format.schema.properties,
    ).toHaveProperty("scratchpad");
    expect(
      streamTextSpan.input.output.response_format.schema.properties,
    ).toHaveProperty("answer");
  });

  test("generateText with Output.object logs schema correctly", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const schema = z.object({
      result: z.number().describe("The numerical result"),
    });

    const outputSchema = ai.Output.object({
      schema,
    });

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      output: outputSchema,
      messages: [
        {
          role: "user",
          content: "What is 5 multiplied by 7?",
        },
      ],
      maxOutputTokens: 100,
    });

    expect(result).toBeTruthy();

    const spans = (await backgroundLogger.drain()) as any[];
    const generateTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "generateText",
    );

    expect(generateTextSpan).toBeTruthy();

    // Verify input contains the output schema
    expect(generateTextSpan.input).toBeTruthy();
    expect(generateTextSpan.input.output).toBeTruthy();

    // The schema should be serialized with response_format containing the schema
    expect(generateTextSpan.input.output.response_format).toBeTruthy();
    expect(generateTextSpan.input.output.response_format.type).toBe("json");
    expect(generateTextSpan.input.output.response_format.schema).toBeTruthy();
    expect(
      generateTextSpan.input.output.response_format.schema.properties,
    ).toHaveProperty("result");
  });

  test("streamText with Output.object using complex schema", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const schema = z.object({
      analysis: z.string().describe("Analysis of the problem"),
      result: z.number().describe("The numerical result"),
      confidence: z.number().min(0).max(1).describe("Confidence in the result"),
    });

    const outputSchema = ai.Output.object({
      schema,
    });

    const model = openai(TEST_MODEL);

    const stream = wrappedAI.streamText({
      model,
      output: outputSchema,
      messages: [
        {
          role: "user",
          content: "What is 7 * 8? Provide analysis, result, and confidence.",
        },
      ],
      maxOutputTokens: 200,
    });

    for await (const chunk of stream.textStream) {
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamText",
    );

    expect(streamTextSpan).toBeTruthy();
    expect(streamTextSpan.input.output).toBeTruthy();
    expect(streamTextSpan.input.output.response_format).toBeTruthy();
    expect(streamTextSpan.input.output.response_format.type).toBe("json");
    expect(streamTextSpan.input.output.response_format.schema).toBeTruthy();

    const schemaProps =
      streamTextSpan.input.output.response_format.schema.properties;
    expect(schemaProps).toHaveProperty("analysis");
    expect(schemaProps).toHaveProperty("result");
    expect(schemaProps).toHaveProperty("confidence");

    expect(schemaProps.analysis.description).toBe("Analysis of the problem");
    expect(schemaProps.result.description).toBe("The numerical result");
    expect(schemaProps.confidence.description).toBe("Confidence in the result");
  });

  test("generateText with Output.object using nested schema", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const schema = z.object({
      city: z.string().describe("The city name"),
      country: z.string().describe("The country name"),
      population: z.number().describe("Approximate population"),
      coordinates: z.object({
        latitude: z.number(),
        longitude: z.number(),
      }),
    });

    const outputSchema = ai.Output.object({
      schema,
    });

    const model = openai(TEST_MODEL);

    const result = await wrappedAI.generateText({
      model,
      output: outputSchema,
      messages: [
        {
          role: "user",
          content: "Tell me about Paris including coordinates",
        },
      ],
      maxOutputTokens: 200,
    });

    expect(result).toBeTruthy();

    const spans = (await backgroundLogger.drain()) as any[];
    const generateTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "generateText",
    );

    expect(generateTextSpan).toBeTruthy();
    expect(generateTextSpan.input.output).toBeTruthy();
    expect(generateTextSpan.input.output.response_format).toBeTruthy();
    expect(generateTextSpan.input.output.response_format.type).toBe("json");
    expect(generateTextSpan.input.output.response_format.schema).toBeTruthy();

    const schemaProps =
      generateTextSpan.input.output.response_format.schema.properties;
    expect(schemaProps).toHaveProperty("city");
    expect(schemaProps).toHaveProperty("country");
    expect(schemaProps).toHaveProperty("population");
    expect(schemaProps).toHaveProperty("coordinates");

    expect(schemaProps.coordinates.type).toBe("object");
    expect(schemaProps.coordinates.properties).toHaveProperty("latitude");
    expect(schemaProps.coordinates.properties).toHaveProperty("longitude");
  });

  test("streamText with Output.object and string model (gateway-style)", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const schema = z.object({
      answer: z.string().describe("The answer"),
      reasoning: z.string().describe("Step by step reasoning"),
    });

    const outputSchema = ai.Output.object({
      schema,
    });

    const stream = wrappedAI.streamText({
      model: "openai/gpt-4o-mini" as any,
      output: outputSchema,
      messages: [
        {
          role: "user",
          content: "What is 5 + 5?",
        },
      ],
      maxOutputTokens: 100,
    });

    for await (const chunk of stream.textStream) {
    }

    const spans = (await backgroundLogger.drain()) as any[];
    const streamTextSpan = spans.find(
      (s) => s?.span_attributes?.name === "streamText",
    );

    expect(streamTextSpan).toBeTruthy();
    expect(streamTextSpan.input.output).toBeTruthy();
    expect(streamTextSpan.input.output.response_format).toBeTruthy();
    expect(streamTextSpan.input.output.response_format.type).toBe("json");
    expect(streamTextSpan.input.output.response_format.schema).toBeTruthy();
    expect(
      streamTextSpan.input.output.response_format.schema.properties,
    ).toHaveProperty("answer");
    expect(
      streamTextSpan.input.output.response_format.schema.properties,
    ).toHaveProperty("reasoning");
  });

  test("model/provider separation from gateway-style model string", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const model = openai(TEST_MODEL);

    await wrappedAI.generateText({
      model,
      messages: [
        {
          role: "user",
          content: "Say hello",
        },
      ],
      maxOutputTokens: 50,
    });

    const spans = await backgroundLogger.drain();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generateTextSpan = spans.find(
      (s: any) => s.span_attributes?.name === "generateText",
    ) as any;

    expect(generateTextSpan).toBeDefined();
    expect(generateTextSpan.metadata.model).toBe(TEST_MODEL);
  });
});

const AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY;

describe.skipIf(!AI_GATEWAY_API_KEY)(
  "ai sdk cost extraction tests",
  TEST_SUITE_OPTIONS,
  () => {
    let wrappedAI: typeof ai;
    let backgroundLogger: TestBackgroundLogger;

    beforeAll(async () => {
      await _exportsForTestingOnly.simulateLoginForTests();
    });

    beforeEach(() => {
      backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
      wrappedAI = wrapAISDK(ai);
      initLogger({
        projectName: "ai-sdk-cost.test.ts",
        projectId: "test-project-id",
      });
    });

    afterEach(() => {
      _exportsForTestingOnly.clearTestBackgroundLogger();
    });

    test("cost extraction and model/provider separation", async () => {
      expect(await backgroundLogger.drain()).toHaveLength(0);

      const result = await wrappedAI.generateText({
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: "Say hello in one word.",
          },
        ],
      });

      expect(result.text).toBeTruthy();

      const spans = await backgroundLogger.drain();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generateTextSpan = spans.find(
        (s: any) => s.span_attributes?.name === "generateText",
      ) as any;

      expect(generateTextSpan).toBeDefined();

      // Verify model/provider separation
      expect(generateTextSpan.metadata.model).toBe("gpt-4o-mini");
      expect(generateTextSpan.metadata.provider).toBe("openai");

      // Cost should NOT be on the parent span (to avoid double-counting with
      // child doGenerate spans). It should be on the doGenerate child span.
      expect(generateTextSpan.metrics.estimated_cost).toBeUndefined();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doGenerateSpan = spans.find(
        (s: any) => s.span_attributes?.name === "doGenerate",
      ) as any;
      expect(doGenerateSpan).toBeDefined();
      expect(doGenerateSpan.metrics.estimated_cost).toBeGreaterThan(0);
    });

    test("multi-step tool use extracts total cost", async () => {
      expect(await backgroundLogger.drain()).toHaveLength(0);

      const simpleTool = ai.tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async (args: { message: string }) => `Echo: ${args.message}`,
      });

      const result = await wrappedAI.generateText({
        model: "openai/gpt-4o-mini",
        tools: { echo: simpleTool },
        toolChoice: "required",
        prompt: "Echo the message 'hello'",
        stopWhen: ai.stepCountIs(2),
      });

      expect(result).toBeDefined();

      const spans = await backgroundLogger.drain();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const generateTextSpan = spans.find(
        (s: any) => s.span_attributes?.name === "generateText",
      ) as any;

      expect(generateTextSpan).toBeDefined();

      // Cost should NOT be on the parent span (to avoid double-counting).
      // Individual doGenerate child spans carry per-step costs.
      expect(generateTextSpan.metrics.estimated_cost).toBeUndefined();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doGenerateSpans = spans.filter(
        (s: any) => s.span_attributes?.name === "doGenerate",
      ) as any[];
      expect(doGenerateSpans.length).toBeGreaterThan(0);

      // At least one doGenerate span should have cost
      const totalCost = doGenerateSpans.reduce(
        (sum: number, s: any) => sum + (s.metrics.estimated_cost ?? 0),
        0,
      );
      expect(totalCost).toBeGreaterThan(0);

      // Verify model/provider in metadata
      expect(generateTextSpan.metadata.model).toBe("gpt-4o-mini");
      expect(generateTextSpan.metadata.provider).toBe("openai");
    });
  },
);

describe("extractTokenMetrics", () => {
  test("handles null values in usage without including them in metrics", () => {
    const result = extractTokenMetrics({
      usage: {
        cachedInputTokens: null,
        inputTokens: 100,
        outputTokens: 50,
      },
    });

    expect(result.prompt_tokens).toBe(100);
    expect(result.completion_tokens).toBe(50);
    // null should not be included - it should be undefined or not present
    expect(result.prompt_cached_tokens).toBeUndefined();
  });

  test("preserves zero values in usage", () => {
    const result = extractTokenMetrics({
      usage: {
        cachedInputTokens: 0,
        inputTokens: 100,
        outputTokens: 50,
      },
    });

    expect(result.prompt_tokens).toBe(100);
    expect(result.completion_tokens).toBe(50);
    // Zero should be preserved, not treated as falsy
    expect(result.prompt_cached_tokens).toBe(0);
  });

  test("all metric values are numbers or undefined", () => {
    const result = extractTokenMetrics({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: null,
        reasoningTokens: null,
        completionAudioTokens: null,
      },
    });

    // Every value should be a number or not present (undefined)
    for (const [key, value] of Object.entries(result)) {
      expect(typeof value === "number" || value === undefined).toBe(true);
    }
  });

  test("handles nested usage structure from OpenAI Responses API (gpt-5 models)", () => {
    const result = extractTokenMetrics({
      usage: {
        inputTokens: {
          cacheRead: 0,
          noCache: 25,
          total: 25,
        },
        outputTokens: {
          reasoning: 768,
          text: 22,
          total: 790,
        },
      },
    });

    expect(result.prompt_tokens).toBe(25);
    expect(result.completion_tokens).toBe(790);
    expect(result.reasoning_tokens).toBe(768);
    expect(result.completion_reasoning_tokens).toBe(768);
    expect(result.prompt_cached_tokens).toBe(0);
  });

  test("handles mixed flat and nested usage structures", () => {
    const result = extractTokenMetrics({
      usage: {
        inputTokens: {
          total: 100,
          cacheRead: 10,
        },
        outputTokens: 50,
        totalTokens: 150,
      },
    });

    expect(result.prompt_tokens).toBe(100);
    expect(result.completion_tokens).toBe(50);
    expect(result.tokens).toBe(150);
    expect(result.prompt_cached_tokens).toBe(10);
  });

  test("handles totalUsage field from Agent results", () => {
    const result = extractTokenMetrics({
      totalUsage: {
        inputTokens: 25,
        outputTokens: 50,
        totalTokens: 75,
        reasoningTokens: 20,
      },
    });

    expect(result.prompt_tokens).toBe(25);
    expect(result.completion_tokens).toBe(50);
    expect(result.tokens).toBe(75);
    expect(result.reasoning_tokens).toBe(20);
    expect(result.completion_reasoning_tokens).toBe(20);
  });
});

describe("wrapAISDK with ES module namespace objects", () => {
  test("BEFORE FIX: reproduces Proxy invariant violation with non-configurable properties", () => {
    // NOTE: This test documents what WOULD happen without the fix.
    // With the fix in place, wrapAISDK detects the namespace and uses prototype chain,
    // so this test now expects NO error.

    // Simulate an ES module namespace object with non-configurable properties
    // This mimics what happens in strict ESM environments
    const mockAISDK = {};

    // Define non-configurable properties like ES module namespaces have
    Object.defineProperty(mockAISDK, "generateText", {
      value: async () => ({ text: "mock" }),
      writable: false,
      enumerable: true,
      configurable: false, // This is the key - ES module namespace properties are non-configurable
    });

    Object.defineProperty(mockAISDK, "streamText", {
      value: () => ({ textStream: [] }),
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Verify the property is indeed non-configurable
    const descriptor = Object.getOwnPropertyDescriptor(
      mockAISDK,
      "generateText",
    );
    expect(descriptor?.configurable).toBe(false);
    expect(descriptor?.writable).toBe(false);

    // WITH THE FIX: This should NOT throw because wrapAISDK detects
    // non-configurable properties and uses prototype chain
    expect(() => {
      const wrapped = wrapAISDK(mockAISDK);
      // Try to access the wrapped property - this triggers the Proxy get trap
      wrapped.generateText;
    }).not.toThrow();
  });

  test("prototype chain approach preserves all properties including non-enumerable", () => {
    // Simulate an ES module namespace object with both enumerable and non-enumerable properties
    const mockAISDK = {};

    Object.defineProperty(mockAISDK, "generateText", {
      value: async () => ({ text: "mock" }),
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(mockAISDK, "streamText", {
      value: () => ({ textStream: [] }),
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Add a non-enumerable property (like Symbol.toStringTag or hidden internals)
    Object.defineProperty(mockAISDK, "hiddenProperty", {
      value: "secret",
      writable: false,
      enumerable: false, // Non-enumerable!
      configurable: false,
    });

    // Approach 1: Spreading (loses non-enumerable properties)
    const spreadSDK = { ...mockAISDK };
    expect("generateText" in spreadSDK).toBe(true);
    expect("hiddenProperty" in spreadSDK).toBe(false); // Lost!

    // Approach 2: Prototype chain (preserves everything)
    const protoSDK = Object.setPrototypeOf({}, mockAISDK);
    expect("generateText" in protoSDK).toBe(true);
    expect("hiddenProperty" in protoSDK).toBe(true); // Preserved!
    expect(protoSDK.hiddenProperty).toBe("secret");

    // Verify the target has no own properties, avoiding invariant issues
    expect(Object.keys(protoSDK).length).toBe(0);
    expect(Object.getOwnPropertyNames(protoSDK).length).toBe(0);

    // This should NOT throw because target has no non-configurable properties
    expect(() => {
      const wrapped = wrapAISDK(protoSDK);
      wrapped.generateText;
      expect(wrapped.hiddenProperty).toBe("secret"); // Still accessible
    }).not.toThrow();
  });

  test("handles both plain objects and ModuleRecord-like objects", () => {
    // Plain objects (common in Node.js/bundled environments)
    const plainObject = {
      generateText: async () => ({ text: "mock" }),
      streamText: () => ({ textStream: [] }),
    };

    // These properties are configurable by default
    const plainDescriptor = Object.getOwnPropertyDescriptor(
      plainObject,
      "generateText",
    );
    expect(plainDescriptor?.configurable).toBe(true);

    // Should work fine - no detection needed
    expect(() => {
      const wrapped = wrapAISDK(plainObject);
      wrapped.generateText;
    }).not.toThrow();

    // ModuleRecord-like object (strict ESM environments)
    const moduleRecord = {};
    Object.defineProperty(moduleRecord, "generateText", {
      value: async () => ({ text: "mock" }),
      writable: false,
      enumerable: true,
      configurable: false, // Non-configurable like real ModuleRecords
    });

    const moduleDescriptor = Object.getOwnPropertyDescriptor(
      moduleRecord,
      "generateText",
    );
    expect(moduleDescriptor?.configurable).toBe(false);

    // WITH THE FIX: Should also work - detected and handled via prototype chain
    expect(() => {
      const wrapped = wrapAISDK(moduleRecord);
      wrapped.generateText;
    }).not.toThrow();
  });

  test("detects objects with constructor.name === 'Module'", () => {
    // Create a mock object that looks like a Module
    class Module {}
    const mockModule = new Module();

    // Add some properties
    Object.defineProperty(mockModule, "generateText", {
      value: async () => ({ text: "mock" }),
      writable: true, // Note: even with writable=true, constructor.name triggers detection
      enumerable: true,
      configurable: true,
    });

    // Verify it has the 'Module' constructor name
    expect(mockModule.constructor.name).toBe("Module");

    // Should not throw - detection via constructor.name should trigger prototype chain
    expect(() => {
      const wrapped = wrapAISDK(mockModule);
      wrapped.generateText;
    }).not.toThrow();
  });

  test("handles edge cases safely", () => {
    // null/undefined
    expect(() => wrapAISDK(null as any)).not.toThrow();
    expect(() => wrapAISDK(undefined as any)).not.toThrow();

    // Empty object
    expect(() => wrapAISDK({})).not.toThrow();

    // Object with no enumerable keys but non-configurable properties
    const noKeys = {};
    Object.defineProperty(noKeys, "hidden", {
      value: "test",
      enumerable: false,
      configurable: false,
    });
    expect(() => wrapAISDK(noKeys)).not.toThrow();
  });

  test("real ModuleRecord test with dynamic import", async () => {
    // This test uses dynamic import to get a real ES module namespace
    // In strict ESM environments, this will be a true ModuleRecord
    const aiModule = await import("ai");

    console.log("=== Dynamic Import Analysis ===");
    console.log("Type:", typeof aiModule);
    console.log("Constructor name:", aiModule.constructor?.name);
    console.log("Has generateText:", "generateText" in aiModule);

    if ("generateText" in aiModule) {
      const descriptor = Object.getOwnPropertyDescriptor(
        aiModule,
        "generateText",
      );
      console.log("generateText descriptor:", {
        configurable: descriptor?.configurable,
        writable: descriptor?.writable,
        enumerable: descriptor?.enumerable,
      });
    }

    // Try wrapping - should not throw with our fix
    expect(() => {
      const wrapped = wrapAISDK(aiModule);
      // Access a property to trigger the Proxy get trap
      if ("generateText" in wrapped) {
        const fn = wrapped.generateText;
        expect(typeof fn).toBe("function");
      }
    }).not.toThrow();

    console.log("✅ wrapAISDK succeeded with real module import");
  });

  test("wrapAgentClass handles private fields correctly", () => {
    // This test verifies that wrapAgentClass doesn't break classes with private fields
    // (if it does, we need to fix it)

    class AgentWithPrivateField {
      #_name: string;
      #_config: Record<string, any>;

      constructor(options: { name: string }) {
        this.#_name = options.name;
        this.#_config = {};
      }

      getName() {
        return this.#_name;
      }

      async generate(params: any) {
        // Access private fields
        const name = this.#_name;
        return {
          text: `Generated by ${name}`,
          config: this.#_config,
        };
      }

      async stream(params: any) {
        return {
          textStream: [this.#_name],
        };
      }
    }

    // Wrap the class
    const WrappedAgentClass = wrapAgentClass(AgentWithPrivateField, {});

    // Create an instance
    const agent = new WrappedAgentClass({ name: "PrivateFieldAgent" });

    // These should NOT throw errors
    expect(() => agent.getName()).not.toThrow();
    expect(agent.getName()).toBe("PrivateFieldAgent");

    // These async methods should also work
    expect(async () => {
      const result = await agent.generate({ test: true });
      expect(result.text).toBe("Generated by PrivateFieldAgent");
    }).not.toThrow();
  });
});
