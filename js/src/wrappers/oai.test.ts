import {
  test,
  assert,
  beforeEach,
  beforeAll,
  afterEach,
  describe,
  expect,
  vi,
} from "vitest";
import { configureNode } from "../node/config";
import OpenAI from "openai";
import {
  _exportsForTestingOnly,
  initLogger,
  Logger,
  TestBackgroundLogger,
  Attachment,
} from "../logger";
import { wrapOpenAI } from "./oai";
import { getCurrentUnixTimestamp } from "../util";
import { parseMetricsFromUsage } from "./oai_responses";

// use the cheapest model for tests
const TEST_MODEL = "gpt-4o-mini";
const TEST_SUITE_OPTIONS = { timeout: 30000, retry: 3 };

try {
  configureNode();
} catch {
  // FIXME[matt] have a better of way of initializing brainstrust state once per process.
}

test("openai is installed", () => {
  assert.ok(OpenAI);
});

test("wrapOpenAI keeps private-field helper methods callable", async () => {
  const wrapped = wrapOpenAI(new OpenAI({ apiKey: "test-key" }));

  expect(wrapped.buildURL).toBe(wrapped.buildURL);
  expect(wrapped.buildRequest).toBe(wrapped.buildRequest);
  expect(() => wrapped.buildURL("/files", null)).not.toThrow();

  const request = await wrapped.buildRequest(
    { method: "post", path: "/files" },
    { retryCount: 0 },
  );
  expect(request.url).toContain("/files");
});

describe("openai client unit tests", TEST_SUITE_OPTIONS, () => {
  let oai: OpenAI;
  let client: OpenAI;
  let backgroundLogger: TestBackgroundLogger;
  let _logger: Logger<false>;

  // fake login before we test. once is enough.
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    oai = new OpenAI();
    client = wrapOpenAI(oai);
    _logger = initLogger({
      projectName: "openai.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test(
    "openai.chat.completions.streaming",
    { timeout: 30000 },
    async (context) => {
      assert.lengthOf(await backgroundLogger.drain(), 0);

      for (const includeUsage of [false, true]) {
        const start = getCurrentUnixTimestamp();
        const stream = await client.chat.completions.create({
          messages: [{ role: "user", content: "1+1" }],
          model: TEST_MODEL,
          stream: true,
          stream_options: {
            include_usage: includeUsage,
          },
        });

        let ttft = -1.0;
        for await (const event of stream) {
          if (ttft < 0) {
            ttft = getCurrentUnixTimestamp() - start;
          }
          assert.ok(event);
        }
        const end = getCurrentUnixTimestamp();

        const spans = await backgroundLogger.drain();
        assert.lengthOf(spans, 1);
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
        const span = spans[0] as any;
        assert.equal(span.span_attributes.name, "Chat Completion");
        assert.equal(span.span_attributes.type, "llm");
        const m = span.metrics;
        assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
        assert.isTrue(ttft >= m.time_to_first_token);
        if (includeUsage) {
          assert.isTrue(m.tokens > 0);
          assert.isTrue(m.prompt_tokens > 0);
          assert.isTrue(m.time_to_first_token > 0);
          assert.isTrue(m.prompt_cached_tokens >= 0);
          assert.isTrue(m.completion_reasoning_tokens >= 0);
        } else {
          assert.isTrue(m.tokens === undefined);
        }
      }
    },
  );

  test("openai.chat.completions", async (context) => {
    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const result = await client.chat.completions.create({
      messages: [
        {
          role: "user",
          content: "Hello! Can you tell me a joke?",
        },
      ],
      model: TEST_MODEL,
      max_tokens: 100,
    });
    const end = getCurrentUnixTimestamp();
    assert.ok(result);

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.ok(span);
    assert.equal(span.span_attributes.type, "llm");
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.equal(span.metadata.provider, "openai");
    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(m.time_to_first_token > 0);
    assert.isTrue(m.prompt_cached_tokens >= 0);
    assert.isTrue(m.completion_reasoning_tokens >= 0);
  });

  test("openai.chat.completions with images converts to attachments", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const start = getCurrentUnixTimestamp();

    // Create a simple 1x1 red PNG as base64
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const result = await client.chat.completions.create({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What's in this image?",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      model: TEST_MODEL,
      max_tokens: 50,
    });
    const end = getCurrentUnixTimestamp();

    expect(result).toBeTruthy();
    expect(result.choices).toHaveLength(1);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    expect(span.span_attributes.name).toBe("Chat Completion");
    expect(span.span_attributes.type).toBe("llm");

    // Check that the input contains the message with the image
    expect(span.input).toBeTruthy();
    expect(Array.isArray(span.input)).toBe(true);
    expect(span.input.length).toBeGreaterThan(0);

    // Find the message with image content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messageWithImage = span.input.find(
      (msg: any) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Array.isArray(msg.content) &&
        msg.content.some((c: any) => c.type === "image_url"),
    );

    expect(messageWithImage).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageContent = messageWithImage.content.find(
      (c: any) => c.type === "image_url",
    );
    expect(imageContent).toBeTruthy();

    // Check the output - for vision models, the output is just text (the model's description)
    // not image content. But this assertion serves as documentation that if models ever
    // return image content in outputs, those should also be converted to attachment references.
    expect(span.output).toBeTruthy();

    // The output contains the assistant's text response, not images
    // Now check the span input for image handling
    const imageUrlValue = imageContent.image_url.url;

    // EXPECTED BEHAVIOR: The data URL should be converted to a Braintrust attachment
    // This validates that images are properly converted to attachments before sending to Braintrust
    expect(imageUrlValue).toBeInstanceOf(Attachment);
    expect(imageUrlValue.reference.type).toBe("braintrust_attachment");
    expect(imageUrlValue.reference.key).toBeTruthy(); // UUID key
    expect(imageUrlValue.reference.content_type).toBe("image/png");
    expect(imageUrlValue.reference.filename).toBeTruthy(); // Should have a filename

    const m = span.metrics;
    expect(start <= m.start && m.start < m.end && m.end <= end).toBe(true);
  });

  test("openai.chat.completions with PDF documents converts to attachments", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const start = getCurrentUnixTimestamp();

    // Create a simple PDF as base64 (minimal valid PDF)
    const base64Pdf =
      "JVBERi0xLjAKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PmVuZG9iagoyIDAgb2JqCjw8L1R5cGUvUGFnZXMvS2lkc1szIDAgUl0vQ291bnQgMT4+ZW5kb2JqCjMgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+ZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1MzUgZg0KMDAwMDAwMDAxMCAwMDAwMCBuDQowMDAwMDAwMDUzIDAwMDAwIG4NCjAwMDAwMDAxMDIgMDAwMDAgbg0KdHJhaWxlcgo8PC9TaXplIDQvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoxNDkKJUVPRg==";

    const result = await client.chat.completions.create({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What's in this document?",
            },
            {
              type: "file",
              file: {
                file_data: `data:application/pdf;base64,${base64Pdf}`,
                filename: "document.pdf",
              },
            },
          ],
        },
      ],
      model: TEST_MODEL,
      max_tokens: 50,
    });
    const end = getCurrentUnixTimestamp();

    expect(result).toBeTruthy();
    expect(result.choices).toHaveLength(1);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    expect(span.span_attributes.name).toBe("Chat Completion");
    expect(span.span_attributes.type).toBe("llm");

    // Check that the input contains the message with the PDF
    expect(span.input).toBeTruthy();
    expect(Array.isArray(span.input)).toBe(true);
    expect(span.input.length).toBeGreaterThan(0);

    // Find the message with file content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messageWithFile = span.input.find(
      (msg: any) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Array.isArray(msg.content) &&
        msg.content.some((c: any) => c.type === "file"),
    );

    expect(messageWithFile).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fileContent = messageWithFile.content.find(
      (c: any) => c.type === "file",
    );
    expect(fileContent).toBeTruthy();

    // Check the output
    expect(span.output).toBeTruthy();

    // Now check the span input for PDF/document handling
    const fileDataValue = fileContent.file.file_data;

    // EXPECTED BEHAVIOR: The data URL should be converted to a Braintrust attachment
    // This validates that PDFs/documents are properly converted to attachments before sending to Braintrust
    expect(fileDataValue).toBeInstanceOf(Attachment);
    expect(fileDataValue.reference.type).toBe("braintrust_attachment");
    expect(fileDataValue.reference.key).toBeTruthy(); // UUID key
    expect(fileDataValue.reference.content_type).toBe("application/pdf");
    expect(fileDataValue.reference.filename).toBeTruthy(); // Should have a filename

    const m = span.metrics;
    expect(start <= m.start && m.start < m.end && m.end <= end).toBe(true);
  });

  test("openai.chat.completions.tools", { timeout: 30000 }, async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    // Define tools that can be called in parallel
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "get_weather",
          description: "Get the weather for a location",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The location to get weather for",
              },
            },
            required: ["location"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "get_time",
          description: "Get the current time for a timezone",
          parameters: {
            type: "object",
            properties: {
              timezone: {
                type: "string",
                description: "The timezone to get time for",
              },
            },
            required: ["timezone"],
          },
        },
      },
    ];

    for (const stream of [false, true]) {
      const startTime = getCurrentUnixTimestamp();

      const result = await client.chat.completions.create({
        messages: [
          {
            role: "user",
            content: "What's the weather in New York and the time in Tokyo?",
          },
        ],
        model: TEST_MODEL,
        tools: tools,
        temperature: 0,
        stream: stream,
        stream_options: stream ? { include_usage: true } : undefined,
      });

      if (stream) {
        // Consume the stream
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
        for await (const _chunk of result as any) {
          // Exhaust the stream
        }
      }

      const endTime = getCurrentUnixTimestamp();

      const spans = await backgroundLogger.drain();
      expect(spans).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
      const span = spans[0] as any;

      expect(span).toMatchObject({
        project_id: expect.any(String),
        log_id: expect.any(String),
        created: expect.any(String),
        span_id: expect.any(String),
        root_span_id: expect.any(String),
        span_attributes: {
          type: "llm",
          name: "Chat Completion",
        },
        metadata: {
          model: TEST_MODEL,
          provider: "openai",
          stream: stream,
          tools: expect.arrayContaining([
            expect.objectContaining({
              type: "function",
              function: expect.objectContaining({
                name: "get_weather",
              }),
            }),
            expect.objectContaining({
              type: "function",
              function: expect.objectContaining({
                name: "get_time",
              }),
            }),
          ]),
        },
        input: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "What's the weather in New York and the time in Tokyo?",
          }),
        ]),
        metrics: expect.objectContaining({
          start: expect.any(Number),
          end: expect.any(Number),
        }),
      });

      // Verify tool calls are in the output
      if (span.output && Array.isArray(span.output)) {
        const message = span.output[0]?.message;
        if (message?.tool_calls) {
          expect(message.tool_calls).toHaveLength(2);
          const tool_names = message.tool_calls.map(
            (call: { function: { name: string } }) => call.function.name,
          );
          expect(tool_names).toContain("get_weather");
          expect(tool_names).toContain("get_time");
        }
      }

      // Validate timing
      const { metrics } = span;
      expect(startTime).toBeLessThanOrEqual(metrics.start);
      expect(metrics.start).toBeLessThanOrEqual(metrics.end);
      expect(metrics.end).toBeLessThanOrEqual(endTime);

      // Token metrics might be available depending on the response
      if (metrics.tokens !== undefined) {
        expect(metrics.tokens).toBeGreaterThan(0);
        expect(metrics.prompt_tokens).toBeGreaterThan(0);
        expect(metrics.prompt_cached_tokens).toBeGreaterThanOrEqual(0);
        expect(metrics.completion_reasoning_tokens).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("openai.responses.stream", async (context) => {
    if (!oai.responses) {
      context.skip();
    }
    assert.lengthOf(await backgroundLogger.drain(), 0);

    const onEvent = vi.fn();
    const onDelta = vi.fn();
    const onIteration = vi.fn();

    const start = getCurrentUnixTimestamp();
    const stream = await client.responses
      .stream({
        model: TEST_MODEL,
        input: "What is 6x6?",
      })
      .on("event", onEvent)
      .on("response.output_text.delta", onDelta);

    for await (const event of stream) {
      onIteration(event);
      assert.ok(event);
    }
    const end = getCurrentUnixTimestamp();

    // make sure we don't break the API.
    expect(onEvent).toHaveBeenCalled();
    expect(onDelta).toHaveBeenCalled();
    expect(onIteration).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await stream.finalResponse();
    expect(result.output[0].content[0].text).toContain("36");

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.create");
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.input, "What is 6x6?");
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.equal(span.metadata.provider, "openai");
    // Check if output contains "36" either in the structure or stringified
    const outputStr = JSON.stringify(span.output);
    expect(outputStr).toContain("36");

    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(m.time_to_first_token > 0);
    assert.isTrue(m.prompt_cached_tokens >= 0);
    assert.isTrue(m.completion_reasoning_tokens >= 0);
  });

  test("openai.responses.create(stream=true)", async (context) => {
    if (!oai.responses) {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const stream = await client.responses.create({
      model: TEST_MODEL,
      input: "Read me a few lines of Sonnet 18",
      instructions: "the whole poem, strip punctuation",
      stream: true,
      temperature: 0.5,
    });

    assert.ok(stream);

    for await (const event of stream) {
      assert.ok(event);
      continue;
    }
    const end = getCurrentUnixTimestamp();

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.create");
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.input, "Read me a few lines of Sonnet 18");
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.equal(span.metadata.provider, "openai");
    assert.equal(
      span.metadata.instructions,
      "the whole poem, strip punctuation",
    );
    assert.equal(span.metadata.temperature, 0.5);
    // Check if output contains the expected text either in the structure or stringified
    const outputStr = JSON.stringify(span.output).toLowerCase();
    expect(outputStr).toContain("shall i compare thee");
    const m = span.metrics;
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.time_to_first_token > 0);
  });

  test("openai.responses.create(stream=false)", async (context) => {
    if (!oai.responses) {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const response = await client.responses.create({
      model: TEST_MODEL,
      input: "What is the capital of France?",
    });
    const end = getCurrentUnixTimestamp();

    assert.ok(response);
    expect(response.output_text).toContain("Paris");

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.create");
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.input, "What is the capital of France?");
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.equal(span.metadata.provider, "openai");
    // Check if output contains "Paris" either in the structure or stringified
    const outputStr = JSON.stringify(span.output);
    expect(outputStr).toContain("Paris");
    const m = span.metrics;
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.time_to_first_token > 0);
  });

  test("openai.responses.create withResponse", async (context) => {
    if (!oai.responses) {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const { data, response } = await client.responses
      .create({
        model: TEST_MODEL,
        input: "What is 2+2? Reply with just the number.",
      })
      .withResponse();
    const end = getCurrentUnixTimestamp();

    // Verify data
    assert.ok(data);
    expect(data.output_text).toContain("4");

    // Verify response object (duck-typing check for Response)
    expect(typeof response.json).toBe("function");
    expect(typeof response.text).toBe("function");
    expect(response.headers).toBeDefined();
    expect(response.status).toBe(200);

    // Verify span was logged correctly
    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.create");
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.input, "What is 2+2? Reply with just the number.");
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.equal(span.metadata.provider, "openai");
    const outputStr = JSON.stringify(span.output);
    expect(outputStr).toContain("4");
    const m = span.metrics;
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.time_to_first_token > 0);
  });

  test("openai.responses.parse", async (context) => {
    if (!oai.responses) {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    // Define a simple schema for structured output
    const NumberAnswerSchema = {
      type: "object",
      properties: {
        value: { type: "integer" },
        reasoning: { type: "string" },
      },
      required: ["value", "reasoning"],
      additionalProperties: false,
    };

    // Test with unwrapped client first - should work but no spans
    const unwrappedResponse = await oai.responses.parse({
      model: TEST_MODEL,
      input: "What is 20 + 4?",
      text: {
        format: {
          name: "NumberAnswer",
          type: "json_schema",
          schema: NumberAnswerSchema,
        },
      },
    });

    assert.ok(unwrappedResponse);
    // The parse method returns a response with output_parsed field
    assert.ok(unwrappedResponse.output_parsed);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const unwrapped_output_parsed = unwrappedResponse.output_parsed as any;
    assert.equal(unwrapped_output_parsed.value, 24);
    assert.ok(unwrapped_output_parsed.reasoning);

    // No spans should be generated with unwrapped client
    assert.lengthOf(await backgroundLogger.drain(), 0);

    // Now test with wrapped client - should generate spans
    const start = getCurrentUnixTimestamp();
    const response = await client.responses.parse({
      model: TEST_MODEL,
      input: "What is 20 + 4?",
      text: {
        format: {
          name: "NumberAnswer",
          type: "json_schema",
          schema: NumberAnswerSchema,
        },
      },
    });
    const end = getCurrentUnixTimestamp();

    assert.ok(response);
    // The parse method returns a response with output_parsed field
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const output_parsed = response.output_parsed as any;
    assert.equal(output_parsed.value, 24);
    assert.ok(output_parsed.reasoning);

    // Verify spans were created
    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.parse");
    assert.equal(span.span_attributes.type, "llm");
    assert.equal(span.input, "What is 20 + 4?");
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.equal(span.metadata.provider, "openai");
    assert.ok(span.metadata.text);
    // For parse operations, check if the parsed data is in the output structure
    const outputStr = JSON.stringify(span.output);
    expect(outputStr).toContain("24");
    expect(span.output).toBeDefined();
    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(m.prompt_cached_tokens >= 0);
    assert.isTrue(m.completion_reasoning_tokens >= 0);
  });

  test("openai.responses.compact", { timeout: 30000 }, async (context) => {
    if (!oai.responses || typeof oai.responses.compact !== "function") {
      context.skip();
    }
    const wrappedCompact = client.responses?.compact;
    if (typeof wrappedCompact !== "function") {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    const compactInput = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "My name is Ada and I like concise responses.",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Nice to meet you, Ada. I will keep responses concise.",
          },
        ],
      },
    ];

    const compactArgs = {
      model: TEST_MODEL,
      input: compactInput,
      instructions: "Keep only durable user preferences.",
    };

    const unwrappedResponse = await oai.responses.compact(compactArgs);
    assert.ok(unwrappedResponse);
    assert.lengthOf(await backgroundLogger.drain(), 0);

    const start = getCurrentUnixTimestamp();
    const response = await wrappedCompact(compactArgs);
    const end = getCurrentUnixTimestamp();

    assert.ok(response);

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "openai.responses.compact");
    assert.equal(span.span_attributes.type, "llm");
    assert.deepEqual(span.input, compactInput);
    assert.equal(span.metadata.provider, "openai");
    assert.equal(span.metadata.instructions, compactArgs.instructions);
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.isDefined(span.output);

    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    if (m.tokens !== undefined) {
      assert.isTrue(m.tokens > 0);
      assert.isTrue(m.prompt_tokens > 0);
    }
  });

  test("openai.chat.completions.parse (v5 GA method)", async () => {
    // Test that the parse method is properly wrapped in the GA namespace (v5)
    if (!oai.chat?.completions?.parse) {
      // Skip if parse method not available (older SDK version)
      return;
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);

    // Use a simple schema for testing
    const schema = {
      type: "object",
      properties: {
        answer: { type: "number" },
      },
      required: ["answer"],
    };

    const start = getCurrentUnixTimestamp();
    const result = await client.chat.completions.parse({
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      model: TEST_MODEL,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "math_response",
          schema: schema,
        },
      },
    });
    const end = getCurrentUnixTimestamp();

    assert.ok(result);

    const spans = await backgroundLogger.drain();
    assert.lengthOf(spans, 1);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const span = spans[0] as any;
    assert.equal(span.span_attributes.name, "Chat Completion");
    assert.equal(span.span_attributes.type, "llm");
    assert.ok(span.metadata.model.startsWith(TEST_MODEL));
    assert.equal(span.metadata.provider, "openai");
    const m = span.metrics;
    assert.isTrue(start <= m.start && m.start < m.end && m.end <= end);
    assert.isTrue(m.tokens > 0);
    assert.isTrue(m.prompt_tokens > 0);
    assert.isTrue(m.time_to_first_token > 0);
  });

  test("openai.responses with image processing", async (context) => {
    if (!oai.responses) {
      context.skip();
    }

    assert.lengthOf(await backgroundLogger.drain(), 0);
    // Create a mock client response with APIPromise semantics.
    const mockData = {
      output: [
        {
          type: "image_generation_call",
          result:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", // Simple 1x1 PNG in base64
          output_format: "png",
          revised_prompt: "A simple test image",
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    };
    const mockResponse = new Response(null, { status: 200 });
    const mockCreate = vi.fn().mockImplementation(() => {
      const apiPromise = Promise.resolve(mockData) as any;
      apiPromise.withResponse = vi.fn().mockResolvedValue({
        data: mockData,
        response: mockResponse,
      });
      return apiPromise;
    });

    // Replace the client.responses.create method temporarily
    const originalCreate = client.responses.create;
    client.responses.create = mockCreate as any;

    try {
      const start = getCurrentUnixTimestamp();
      const response = await client.responses.create({
        model: TEST_MODEL,
        input: "Generate a simple test image",
      });
      const end = getCurrentUnixTimestamp();

      // Verify the response contains the expected structure
      assert.ok(response);
      assert.ok(response.output);
      assert.isArray(response.output);

      // Get the logged spans
      const spans = await backgroundLogger.drain();
      assert.lengthOf(spans, 1);
      const span = spans[0] as any;

      assert.equal(span.span_attributes.name, "openai.responses.create");
      assert.equal(span.span_attributes.type, "llm");
      assert.equal(span.input, "Generate a simple test image");
      assert.ok(span.metadata.model.startsWith(TEST_MODEL));
      assert.equal(span.metadata.provider, "openai");

      // Verify the output was processed and contains an Attachment
      assert.ok(span.output);
      assert.isArray(span.output);
      const outputItem = span.output[0];
      assert.equal(outputItem.type, "image_generation_call");

      // Verify that the base64 string was replaced with a braintrust attachment
      assert.instanceOf(outputItem.result, Attachment);
      assert.equal(outputItem.result.reference.type, "braintrust_attachment");
      assert.ok(outputItem.result.reference.key); // Should have a UUID key
      assert.equal(outputItem.result.reference.content_type, "image/png");
      assert.ok(
        outputItem.result.reference.filename.includes("A_simple_test_image"),
      );
      const m = span.metrics;
      // Metrics are logged asynchronously; end can land after the awaited call resolves.
      assert.isTrue(start <= m.start && m.start <= m.end);
      assert.isTrue(m.end <= getCurrentUnixTimestamp());
    } finally {
      // Restore the original method
      client.responses.create = originalCreate;
    }
  });

  const getFirstLog = async () => {
    const events = await backgroundLogger.drain();
    expect(events.length).toBe(1);
    // eslint-disable-next-line
    return events[0] as any;
  };

  test("non-streaming completion allows access to data and response", async () => {
    const completion = client.chat.completions.create({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "Say 'test'" }],
      max_tokens: 5,
    });

    // Get the full response with data. This executes the request.
    const { data, response } = await completion.withResponse();
    expect(data.choices[0].message.content).toBeDefined();
    // Duck-typing check for Response object
    expect(typeof response.json).toBe("function");
    expect(typeof response.text).toBe("function");
    expect(response.headers).toBeDefined();
    expect(response.status).toBe(200);

    // Await the promise directly and check if the data is consistent from cache.
    const dataOnly = await completion;
    expect(dataOnly).toBe(data); // Should be the exact same object

    // Verify that the logs are correct.
    const event = await getFirstLog();
    expect(event.span_id).toBeDefined();
    expect(event.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(event.metrics.completion_tokens).toBeGreaterThan(0);
    expect(event.input).toEqual([{ role: "user", content: "Say 'test'" }]);
    expect(event.output).toEqual(data.choices);
  });

  test("streaming completion allows access to stream and response", async () => {
    const completion = client.chat.completions.create({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "Say 'Hello'" }],
      stream: true,
    });

    // Get the stream and response. This executes the request.
    const { data: stream, response } = await completion.withResponse();
    // Duck-typing check for Response object
    expect(typeof response.json).toBe("function");
    expect(typeof response.text).toBe("function");
    expect(response.headers).toBeDefined();
    expect(response.status).toBe(200);

    // Await the promise directly to get the same stream from cache.
    const streamOnly = await completion;
    expect(streamOnly).toBe(stream);

    // Consume the stream to ensure it's valid.
    let content = "";
    for await (const chunk of streamOnly) {
      content += chunk.choices[0]?.delta?.content || "";
    }
    expect(content.length).toBeGreaterThan(0);

    // Verify that the logs are correct after the stream is consumed.
    const event = await getFirstLog();
    expect(event.span_id).toBeDefined();

    expect(event.input).toEqual([{ role: "user", content: "Say 'Hello'" }]);

    // In streaming, the output is an array of choices with the reconstructed message.
    // eslint-disable-next-line
    const output = event.output as any;
    expect(output[0].message.role).toBe("assistant");
    expect(output[0].message.content).toEqual(content);
  });

  test("non-streaming completion without withResponse works", async () => {
    const completion = client.chat.completions.create({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "Just say 'hi'" }],
      max_tokens: 5,
    });

    // Await the promise directly.
    const data = await completion;
    expect(data.choices[0].message.content).toBeDefined();

    // Verify that the logs are correct.
    const event = await getFirstLog();
    expect(event.span_id).toBeDefined();
    expect(event.metrics.prompt_tokens).toBeGreaterThan(0);
    expect(event.metrics.completion_tokens).toBeGreaterThan(0);
    expect(event.input).toEqual([{ role: "user", content: "Just say 'hi'" }]);
    expect(event.output).toEqual(data.choices);
  });

  test("streaming completion without withResponse works", async () => {
    const completion = client.chat.completions.create({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "Hello there" }],
      stream: true,
    });

    // Await the promise directly to get the stream.
    const stream = await completion;

    // Consume the stream to ensure it's valid and trigger logging.
    let content = "";
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta?.content || "";
    }
    expect(content.length).toBeGreaterThan(0);

    // Verify that the logs are correct after the stream is consumed.
    const event = await getFirstLog();
    expect(event.span_id).toBeDefined();
    expect(event.input).toEqual([{ role: "user", content: "Hello there" }]);

    // In streaming, the output is an array of choices with the reconstructed message.
    // eslint-disable-next-line
    const output = event.output as any;
    expect(output[0].message.role).toBe("assistant");
    expect(output[0].message.content).toEqual(content);
  });

  test("invalid API key does not cause unhandled rejection with withResponse", async () => {
    // Create client with invalid API key
    const invalidClient = wrapOpenAI(new OpenAI({ apiKey: "invalid-api-key" }));

    // Track if any unhandled rejections occur
    let unhandledRejection: any = null;
    const handler = (reason: any) => {
      unhandledRejection = reason;
    };
    process.on("unhandledRejection", handler);

    try {
      // This should throw an error but not cause an unhandled rejection
      const streamPromise = invalidClient.chat.completions.create({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "test" }],
        stream: true,
        stream_options: { include_usage: true },
      });

      // The promise should only execute when withResponse is called
      await streamPromise.withResponse();

      // Should not reach here
      expect.fail("Expected an authentication error");
    } catch (error: any) {
      // Error should be caught properly
      expect(error.message).toContain("api");
    } finally {
      process.removeListener("unhandledRejection", handler);
    }

    // Give a moment for any async unhandled rejections to be detected
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify no unhandled rejection occurred
    expect(unhandledRejection).toBeNull();
  });

  test("embeddings.create returns APIPromise with .withResponse()", async () => {
    assert.lengthOf(await backgroundLogger.drain(), 0);

    const mockEmbeddingData = {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 2, total_tokens: 2 },
    };
    const mockHeaders = new Headers({
      "x-ratelimit-limit-requests": "3000",
      "x-ratelimit-remaining-requests": "2999",
    });
    const mockResponse = new Response(null, {
      status: 200,
      headers: mockHeaders,
    });

    const mockCreate = vi.fn().mockImplementation(() => {
      const p = Promise.resolve(mockEmbeddingData) as any;
      p.withResponse = () =>
        Promise.resolve({ data: mockEmbeddingData, response: mockResponse });
      return p;
    });

    const mockOai = new OpenAI({ apiKey: "sk-fake" });
    mockOai.embeddings.create = mockCreate;
    const wrappedMock = wrapOpenAI(mockOai);

    const embeddingPromise = wrappedMock.embeddings.create({
      model: "text-embedding-3-small",
      input: "Hello world",
    });

    expect(typeof embeddingPromise.withResponse).toBe("function");

    const { data, response } = await embeddingPromise.withResponse();
    expect(data).toEqual(mockEmbeddingData);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit-requests")).toBe("3000");

    // Awaiting the promise directly should also work
    const directResult = await wrappedMock.embeddings.create({
      model: "text-embedding-3-small",
      input: "Hello world",
    });
    expect(directResult).toEqual(mockEmbeddingData);
  });

  test("invalid API key does not cause unhandled rejection without withResponse", async () => {
    // Create client with invalid API key
    const invalidClient = wrapOpenAI(new OpenAI({ apiKey: "invalid-api-key" }));

    // Track if any unhandled rejections occur
    let unhandledRejection: any = null;
    const handler = (reason: any) => {
      unhandledRejection = reason;
    };
    process.on("unhandledRejection", handler);

    try {
      // This should throw an error but not cause an unhandled rejection
      const result = await invalidClient.chat.completions.create({
        model: TEST_MODEL,
        messages: [{ role: "user", content: "test" }],
        stream: false,
      });

      // Should not reach here
      expect.fail("Expected an authentication error");
    } catch (error: any) {
      // Error should be caught properly
      expect(error.message).toContain("api");
    } finally {
      process.removeListener("unhandledRejection", handler);
    }

    // Give a moment for any async unhandled rejections to be detected
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify no unhandled rejection occurred
    expect(unhandledRejection).toBeNull();
  });
});

test("parseMetricsFromUsage", () => {
  const usage = {
    input_tokens: 14,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 0, brand_new_token: 12 },
  };
  const metrics = parseMetricsFromUsage(usage);
  assert.equal(metrics.prompt_tokens, 14);
  assert.equal(metrics.prompt_cached_tokens, 0);
  assert.equal(metrics.prompt_brand_new_token, 12);
  assert.equal(metrics.completion_tokens, 8);
  // test a bunch of error conditions
  const totallyBadInputs = [
    null,
    undefined,
    "not an object",
    {},
    { input_tokens: "not a number" },
    { input_tokens_details: "not an object" },
    { input_tokens_details: {} },
    { input_tokens_details: { cached_tokens: "not a number" } },
    { input_tokens_details: { cached_tokens: null } },
    { input_tokens_details: { cached_tokens: undefined } },
  ];
  for (const input of totallyBadInputs) {
    assert.deepEqual(parseMetricsFromUsage(input), {});
  }
});

test("parseMetricsFromUsage with null input_tokens_details", () => {
  const usage = {
    input_tokens: 14,
    output_tokens: 8,
    input_tokens_details: null,
  };
  const metrics = parseMetricsFromUsage(usage);
  assert.equal(metrics.prompt_tokens, 14);
  assert.equal(metrics.prompt_cached_tokens, undefined);
  assert.equal(metrics.prompt_brand_new_token, undefined);
  assert.equal(metrics.completion_tokens, 8);
});
