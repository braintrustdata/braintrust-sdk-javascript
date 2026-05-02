import {
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "./anthropic";
import { _exportsForTestingOnly, Attachment, initLogger } from "../logger";
import { configureNode } from "../node/config";
import { getCurrentUnixTimestamp } from "../util";

// use a low-cost current Haiku alias for tests
const TEST_MODEL = "claude-haiku-4-5";

interface TextBlock {
  type: "text";
  text: string;
}

interface Message {
  content: TextBlock[];
  role: string;
  id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

try {
  configureNode();
} catch (e) {
  // FIXME[matt] have a better of way of initializing brainstrust state once per process.
}

test("anthropic is installed", () => {
  expect(Anthropic).toBeDefined();
});

describe("anthropic client unit tests", { retry: 3 }, () => {
  let anthropic: Anthropic;
  let client: any;
  let backgroundLogger: any;
  let logger: any;

  // fake login before we test. once is enough.
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(async () => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();

    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "test-key",
    });
    client = wrapAnthropic(anthropic);

    logger = initLogger({
      projectName: "anthropic.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("test client.messages.create works with system text blocks", async (context) => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const system: Record<string, string>[] = [
      { text: "translate to english", type: "text" },
      { text: "remove all punctuation", type: "text" },
      { text: "only the answer, no other text", type: "text" },
    ];
    const response = await client.messages.create({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "Bonjour mon ami!" }],
      max_tokens: 20,
      system: system,
      temperature: 0.01,
    });
    expect(response).toBeDefined();

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;
    expect(span["span_attributes"].name).toBe("anthropic.messages.create");
    expect(span.input).toBeDefined();
    const inputsByRole: Record<string, any> = {};
    for (const msg of span.input) {
      inputsByRole[msg["role"]] = msg;
    }
    const userInput = inputsByRole["user"];
    expect(userInput).toBeDefined();
    const systemInput = inputsByRole["system"];
    expect(systemInput.role).toEqual("system");
    expect(systemInput.content).toEqual(system);
  });

  test("test client.messages.stream", async (context) => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    const onMessage = vi.fn();

    const stream = client.messages
      .stream({
        messages: [{ role: "user", content: "tell me about old pond haiku" }],
        system: "no punctuation",
        model: TEST_MODEL,
        max_tokens: 200,
        temperature: 0.01,
      })
      .on("message", onMessage);

    for await (const event of stream) {
      // console.log(event);
    }
    const message = await stream.finalMessage();
    // just making sure we don't break the API.
    expect(onMessage).toHaveBeenCalledTimes(1);

    expect(message.content[0].type).toBe("text");
    const content = message.content[0] as unknown;
    if (typeof content === "object" && content !== null && "text" in content) {
      expect(content.text.toLowerCase()).toContain("old pond");
    } else {
      throw new Error("Content is not a text block");
    }

    const spans = await backgroundLogger.drain();

    expect(spans).toHaveLength(1);
    const span = spans[0] as any;
    expect(span["span_attributes"].name).toBe("anthropic.messages.create");
    const metrics = span.metrics;
    expect(metrics).toBeDefined();
    expect(metrics.start).toBeDefined();
    expect(metrics.end).toBeDefined();
    expect(metrics.time_to_first_token).toBeDefined();
    expect(metrics.prompt_tokens).toBeGreaterThan(0);
    expect(metrics.completion_tokens).toBeGreaterThan(0);
    expect(metrics.tokens).toBeDefined();
  });

  test("test client.messages.create with tools (non-streaming)", async () => {
    const tools = [
      {
        name: "get_weather",
        description: "Get the current weather in a given location",
        input_schema: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "The city and state, e.g. San Francisco, CA",
            },
            unit: {
              type: "string",
              enum: ["celsius", "fahrenheit"],
              description: "The unit of temperature",
            },
          },
          required: ["location"],
        },
      },
    ];

    const response = await client.messages.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: "What's the weather in San Francisco?",
        },
      ],
      max_tokens: 200,
      tools,
      temperature: 0.01,
    });

    expect(response).toBeDefined();
    expect(response.content).toBeDefined();

    const toolUseBlock = response.content.find(
      (block: any) => block.type === "tool_use",
    );
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock).toHaveProperty("name", "get_weather");
    expect(toolUseBlock).toHaveProperty("input");
    expect(toolUseBlock.input).toHaveProperty("location");

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;

    expect(span["span_attributes"].name).toBe("anthropic.messages.create");

    expect(span.output).toBeDefined();
    expect(span.output.content).toBeDefined();

    const outputToolUse = span.output.content.find(
      (block: any) => block.type === "tool_use",
    );
    expect(outputToolUse).toBeDefined();
    expect(outputToolUse.name).toBe("get_weather");
    expect(outputToolUse.input).toBeDefined();

    const metrics = span.metrics;
    expect(metrics).toBeDefined();
    expect(metrics.start).toBeDefined();
    expect(metrics.end).toBeDefined();
    expect(metrics.time_to_first_token).toBeDefined();
    expect(metrics.prompt_tokens).toBeGreaterThan(0);
    expect(metrics.completion_tokens).toBeGreaterThan(0);
    expect(metrics.tokens).toBeDefined();
  });

  test("test client.messages.create with tools and stream=true", async () => {
    const tools = [
      {
        name: "calculate",
        description: "Perform a mathematical calculation",
        input_schema: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["add", "subtract", "multiply", "divide"],
            },
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["operation", "a", "b"],
        },
      },
    ];

    const response = await client.messages.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: "What is 15 plus 27?",
        },
      ],
      max_tokens: 200,
      tools,
      temperature: 0.01,
      stream: true,
    });

    for await (const event of response) {
      // Just consume the events
    }

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;

    expect(span["span_attributes"].name).toBe("anthropic.messages.create");

    const outputToolUse = span.output.content.find(
      (block: any) => block.type === "tool_use",
    );
    expect(outputToolUse).toBeDefined();
    expect(outputToolUse.name).toBe("calculate");
    expect(outputToolUse.input).toBeDefined();
    expect(outputToolUse.input.operation).toBe("add");
    expect(outputToolUse.input.a).toBe(15);
    expect(outputToolUse.input.b).toBe(27);

    const metrics = span.metrics;
    expect(metrics).toBeDefined();
    expect(metrics.start).toBeDefined();
    expect(metrics.end).toBeDefined();
    expect(metrics.time_to_first_token).toBeDefined();
    expect(metrics.prompt_tokens).toBeGreaterThan(0);
    expect(metrics.completion_tokens).toBeGreaterThan(0);
    expect(metrics.tokens).toBeDefined();
  });

  test("test client.beta.messages.create with tools and stream=true", async () => {
    const tools = [
      {
        name: "get_stock_price",
        description: "Get the current stock price",
        input_schema: {
          type: "object",
          properties: {
            symbol: {
              type: "string",
              description: "The stock ticker symbol",
            },
          },
          required: ["symbol"],
        },
      },
    ];

    const response = await client.beta.messages.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: "What's the price of AAPL stock?",
        },
      ],
      max_tokens: 200,
      tools,
      temperature: 0.01,
      stream: true,
    });

    for await (const event of response) {
      // Just consume the events
    }

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;

    expect(span["span_attributes"].name).toBe("anthropic.messages.create");
    expect(span.output).toBeDefined();

    const outputToolUse = span.output.content.find(
      (block: any) => block.type === "tool_use",
    );
    expect(outputToolUse).toBeDefined();
    expect(outputToolUse.name).toBe("get_stock_price");
    expect(outputToolUse.input).toBeDefined();
    expect(outputToolUse.input.symbol).toBeDefined();
    expect(typeof outputToolUse.input.symbol).toBe("string");

    const metrics = span.metrics;
    expect(metrics).toBeDefined();
    expect(metrics.start).toBeDefined();
    expect(metrics.end).toBeDefined();
    expect(metrics.time_to_first_token).toBeDefined();
    expect(metrics.prompt_tokens).toBeGreaterThan(0);
    expect(metrics.completion_tokens).toBeGreaterThan(0);
    expect(metrics.tokens).toBeDefined();
  });

  test("test client.message.create with stream=true", async () => {
    const startTime = getCurrentUnixTimestamp();
    const response = await client.messages.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: "What is Shakespeare's sonnet 18?",
        },
      ],
      max_tokens: 1000,
      system:
        "No punctuation, newlines or non-alphanumeric characters. Just the poem.",
      temperature: 0.01,
      stream: true,
    });

    let ttft = 0;
    for await (const event of response) {
      if (ttft === 0) {
        ttft = getCurrentUnixTimestamp() - startTime;
      }
    }

    const endTime = getCurrentUnixTimestamp();

    // check that the background logger got the log
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;
    expect(span.input).toBeDefined();

    // clean up the output to make it easier to spot check
    const output = span.output
      .toLowerCase()
      .replace(/\n/g, " ")
      .replace(/'/g, "");
    // Validate we collected the streamed text without relying on one exact phrasing.
    // The system prompt says "Just the poem" so the model returns the poem only,
    // not the author's name — only assert on poem content.
    expect(output).toContain("shall i compare thee to a summers day");
    expect(output).toContain("summer");
    expect(output.length).toBeGreaterThan(200);

    expect(span["span_attributes"].type).toBe("llm");
    expect(span["span_attributes"].name).toBe("anthropic.messages.create");
    const metrics = span.metrics;
    expect(metrics).toBeDefined();

    const pt = metrics["prompt_tokens"];
    const ct = metrics["completion_tokens"];
    const t = metrics["tokens"];

    expect(pt).toBeGreaterThan(0);
    expect(ct).toBeGreaterThan(0);
    expect(t).toEqual(pt + ct);
    expect(startTime <= metrics.start).toBe(true);
    expect(metrics.start < metrics.end).toBe(true);
    expect(metrics.end <= endTime).toBe(true);
    expect(ttft).toBeGreaterThanOrEqual(metrics.time_to_first_token);
  });

  test("test client.messages.create basics", async () => {
    const startTime = getCurrentUnixTimestamp();
    const response: Message = await client.messages.create({
      model: TEST_MODEL,
      messages: [{ role: "user", content: "What's 4*4?" }],
      max_tokens: 100,
      system: "Return the result only.",
      temperature: 0.5,
    });
    expect(response).toBeDefined();

    const endTime = getCurrentUnixTimestamp();

    const content = response.content[0] as unknown;
    if (typeof content === "object" && content !== null && "text" in content) {
      expect(content.text).toContain("16");
    } else {
      throw new Error("Content is not a text block");
    }

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;
    expect(span["span_attributes"].type).toBe("llm");
    expect(span["span_attributes"].name).toBe("anthropic.messages.create");
    const metadata = span.metadata;
    expect(metadata?.model).toBe(TEST_MODEL);
    expect(metadata?.provider).toBe("anthropic");
    expect(metadata?.max_tokens).toBe(100);
    expect(metadata["stop_reason"]).toBe("end_turn");
    expect(metadata["temperature"]).toBe(0.5);
    expect(span?.input).toBeDefined();
    expect(span?.output).toBeDefined();
    const output = span.output.content[0].text;
    expect(output).toContain("16");
    const metrics = span.metrics;
    const usage = response.usage;
    expect(metrics).toBeDefined();
    expect(metrics["prompt_tokens"]).toBe(usage.input_tokens);
    expect(metrics["completion_tokens"]).toBe(usage.output_tokens);
    expect(metrics["tokens"]).toBe(usage.input_tokens + usage.output_tokens);
    expect(metrics.prompt_cache_creation_tokens).toBe(
      usage.cache_creation_input_tokens,
    );
    expect(metrics.prompt_cached_tokens).toBe(usage.cache_read_input_tokens);
    expect(metrics.time_to_first_token).toBeDefined();
    expect(metrics.time_to_first_token).toBeGreaterThanOrEqual(0);
    expect(startTime <= metrics.start).toBe(true);
    expect(metrics.start < metrics.end).toBe(true);
    expect(metrics.end <= endTime).toBe(true);
  });

  test("test client.beta.messages.create", async () => {
    let startTime: number = -1;
    let endTime: number = -1;

    // wrapped has to be last so the timing test works
    const clients = [anthropic, client];
    const responses = await Promise.all(
      clients.map(async (c) => {
        startTime = getCurrentUnixTimestamp();

        const response = await c.beta.messages.create({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "What's 4*4?" }],
          max_tokens: 100,
          system: "Return the result only.",
          temperature: 0.1,
        });
        endTime = getCurrentUnixTimestamp();
        return response;
      }),
    );

    // validate that the wrapped and unwrapped clients produce the same response
    assertAnthropicResponsesEqual(responses);

    // validate we traced the second request
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;

    expect(span).toMatchObject({
      project_id: expect.any(String),
      log_id: expect.any(String),
      created: expect.any(String),
      span_id: expect.any(String),
      root_span_id: expect.any(String),
      span_attributes: {
        type: "llm",
        name: "anthropic.messages.create",
      },
      metadata: {
        model: TEST_MODEL,
        provider: "anthropic",
        max_tokens: 100,
        temperature: 0.1,
      },
      input: [
        { role: "user", content: "What's 4*4?" },
        { role: "system", content: "Return the result only." },
      ],
      output: {
        role: "assistant",
        content: [{ type: "text", text: "16" }],
      },
      metrics: {
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
        tokens: expect.any(Number),
        start: expect.any(Number),
        end: expect.any(Number),
        time_to_first_token: expect.any(Number),
      },
    });

    const { metrics } = span;
    assertValidMetrics(metrics, startTime, endTime);
  });

  test("test client.beta.messages.create with stream=true", async () => {
    let startTime: number = -1;
    let endTime: number = -1;

    // wrapped has to be last so the timing test works
    const clients = [anthropic, client];
    const responses = await Promise.all(
      clients.map(async (c) => {
        startTime = getCurrentUnixTimestamp();

        const response = await c.beta.messages.create({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "What's 4*4?" }],
          max_tokens: 100,
          system: "Return the result only.",
          temperature: 0.1,
          stream: true,
        });

        let ttft = 0;
        const chunks = [];
        for await (const event of response) {
          if (ttft === 0) {
            ttft = getCurrentUnixTimestamp() - startTime;
          }
          chunks.push(event);
        }
        endTime = getCurrentUnixTimestamp();
        return chunks;
      }),
    );

    // validate that the wrapped and unwrapped clients produce the same output
    const messages = [];
    const chunks = [];
    for (const resp of responses) {
      assert(resp.length >= 1);
      const msg = resp[0]["message"];
      assert(msg);
      messages.push(msg);
      chunks.push(resp.slice(1));
    }
    assertAnthropicResponsesEqual(messages);
    expect(chunks[0]).toEqual(chunks[1]);

    // validate we traced the second request
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;

    expect(span).toMatchObject({
      project_id: expect.any(String),
      log_id: expect.any(String),
      created: expect.any(String),
      span_id: expect.any(String),
      root_span_id: expect.any(String),
      span_attributes: {
        type: "llm",
        name: "anthropic.messages.create",
      },
      metadata: {
        model: TEST_MODEL,
        provider: "anthropic",
        max_tokens: 100,
        temperature: 0.1,
      },
      input: [
        { role: "user", content: "What's 4*4?" },
        { role: "system", content: "Return the result only." },
      ],
      output: expect.stringContaining("16"),
      metrics: {
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
        tokens: expect.any(Number),
        start: expect.any(Number),
        end: expect.any(Number),
        time_to_first_token: expect.any(Number),
      },
    });

    const { metrics } = span;
    assertValidMetrics(metrics, startTime, endTime);
  });

  test("test client.beta.messages.stream", async () => {
    let startTime: number = -1;
    let endTime: number = -1;

    // wrapped has to be last so the timing test works
    const clients = [anthropic, client];
    const responses = await Promise.all(
      clients.map(async (c) => {
        startTime = getCurrentUnixTimestamp();

        const stream = c.beta.messages.stream({
          model: TEST_MODEL,
          messages: [{ role: "user", content: "What's 4*4?" }],
          max_tokens: 100,
          system: "Return the result only.",
          temperature: 0.1,
        });

        let ttft = 0;
        let chunks = [];
        for await (const event of stream) {
          if (ttft === 0) {
            ttft = getCurrentUnixTimestamp() - startTime;
          }
          chunks.push(event);
        }

        endTime = getCurrentUnixTimestamp();
        return chunks;
      }),
    );

    // validate that the wrapped and unwrapped clients produce the same output
    const respRaw = responses[0];
    const respWrapped = responses[1];

    assertAnthropicResponsesEqual([
      respRaw[0]["message"],
      respWrapped[0]["message"],
    ]);

    expect(respRaw.slice(1)).toEqual(respWrapped.slice(1));

    // validate we traced the second request
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;

    expect(span).toMatchObject({
      project_id: expect.any(String),
      log_id: expect.any(String),
      created: expect.any(String),
      span_id: expect.any(String),
      root_span_id: expect.any(String),
      span_attributes: {
        type: "llm",
        name: "anthropic.messages.create",
      },
      metadata: {
        model: TEST_MODEL,
        provider: "anthropic",
        max_tokens: 100,
        temperature: 0.1,
      },
      input: [
        { role: "user", content: "What's 4*4?" },
        { role: "system", content: "Return the result only." },
      ],
      output: expect.stringContaining("16"),
      metrics: {
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
        tokens: expect.any(Number),
        start: expect.any(Number),
        end: expect.any(Number),
        time_to_first_token: expect.any(Number),
      },
    });

    const { metrics } = span;
    assertValidMetrics(metrics, startTime, endTime);
  });

  test("test base64 image conversion to attachments in input", async () => {
    // Create a small test image (1x1 red pixel PNG)
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const response = await client.messages.create({
      model: TEST_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: base64Image,
              },
            },
            {
              type: "text",
              text: "Describe this image in 3 words or less.",
            },
          ],
        },
      ],
      max_tokens: 20,
      temperature: 0.01,
    });

    expect(response).toBeDefined();
    expect(response.content).toBeDefined();

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    const span = spans[0] as any;

    // Verify that the input was processed
    expect(span.input).toBeDefined();
    const userMessage = span.input.find((msg: any) => msg.role === "user");
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toBeDefined();

    // Find the image content block
    const imageBlock = userMessage.content.find(
      (block: any) => block.type === "image",
    );
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source).toBeDefined();

    // Verify that the base64 data was replaced with an Attachment
    expect(imageBlock.source.data).toBeInstanceOf(Attachment);
    expect(imageBlock.source.data.reference.content_type).toBe("image/png");
    expect(imageBlock.source.data.reference.filename).toBe("image.png");
  });
});

function assertAnthropicResponsesEqual(responses: Message[]) {
  expect(responses.length).toBe(2);
  const parsed = responses.map((r) => JSON.parse(JSON.stringify(r)));
  for (const p of parsed) {
    delete p.id;
  }
  expect(parsed[0]).toEqual(parsed[1]);
}

function assertValidMetrics(metrics: any, start: number, end: number) {
  expect(metrics).toBeDefined();
  expect(metrics.start).toBeDefined();
  expect(metrics.end).toBeDefined();
  expect(metrics.time_to_first_token).toBeDefined();
  expect(metrics.time_to_first_token).toBeGreaterThanOrEqual(0);
  for (const [key, value] of Object.entries(metrics)) {
    expect(value).toBeDefined();
    // if "tokens" is in key, it should be greater than 0
    if (key.includes("tokens")) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }
  expect(start).toBeLessThanOrEqual(metrics.start);
  expect(metrics.start).toBeLessThanOrEqual(metrics.end);
  expect(metrics.end).toBeLessThanOrEqual(end);
}
