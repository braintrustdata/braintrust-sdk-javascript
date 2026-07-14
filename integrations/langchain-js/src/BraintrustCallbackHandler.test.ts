import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import { RunnableMap } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { flush, initLogger, NOOP_SPAN } from "braintrust";
import { http, HttpResponse } from "msw";
import { ReadableStream } from "stream/web";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";

import { BraintrustCallbackHandler } from "./BraintrustCallbackHandler";
import {
  CHAT_BEAR_JOKE,
  CHAT_BEAR_POEM,
  CHAT_CHAIN_MEMORY,
  CHAT_MATH,
  CHAT_SAY_HELLO,
  CHAT_STREAM_PARROT,
  CHAT_TOOL_CALCULATOR,
} from "./BraintrustCallbackHandler.fixtures";
import { server } from "./test/setup";
import { LogsRequest } from "./test/types";
import { logsToSpans, withLogging } from "./test/utils";

initLogger({
  projectName: "langchain",
});

const handler = withLogging(new BraintrustCallbackHandler({ debug: true }));

const encoder = new TextEncoder();

describe("BraintrustCallbackHandler", () => {
  it("should handle LLM calls", async () => {
    const logs: LogsRequest[] = [];

    server.use(
      http.post("https://api.openai.com/v1/chat/completions", () => {
        return HttpResponse.json(CHAT_MATH);
      }),

      http.post(/.+logs/, async ({ request }) => {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        logs.push((await request.json()) as LogsRequest);
        return HttpResponse.json(["4bc6305f-2175-4481-bc84-7c55a456b7ea"]);
      }),
    );

    const prompt = ChatPromptTemplate.fromTemplate(`What is 1 + {number}?`);
    const model = new ChatOpenAI({
      model: "gpt-4o-mini-2024-07-18",
    });

    const chain = prompt.pipe(model);

    const message = await chain.invoke(
      { number: "2" },
      { callbacks: [handler] },
    );

    await flush();

    const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

    expect(spans).toMatchObject([
      {
        span_id: root_span_span_id,
        root_span_id: root_span_id,
        span_attributes: {
          name: "RunnableSequence",
          type: "task",
        },
        input: {
          number: "2",
        },
        metadata: {
          tags: [],
        },
        output: {
          kwargs: {
            content: expect.any(String), // LLM response text
            additional_kwargs: expect.any(Object),
            response_metadata: expect.any(Object),
            tool_calls: expect.any(Array),
            invalid_tool_calls: expect.any(Array),
            usage_metadata: expect.any(Object),
          },
        },
      },
      {
        span_attributes: {
          name: "ChatPromptTemplate",
        },
        input: {
          number: "2",
        },
        metadata: {
          tags: ["seq:step:1"],
        },
        output: {
          kwargs: {
            messages: [
              {
                kwargs: {
                  content: expect.any(String), // Formatted prompt text
                  additional_kwargs: {},
                  response_metadata: {},
                },
              },
            ],
          },
        },
        root_span_id: root_span_id,
        span_parents: [root_span_span_id],
      },
      {
        span_attributes: {
          name: "ChatOpenAI",
          type: "llm",
        },
        input: [
          [
            {
              kwargs: {
                content: expect.any(String), // Prompt message content
                additional_kwargs: {},
                response_metadata: {},
              },
            },
          ],
        ],
        metrics: {
          start: expect.any(Number),
          total_tokens: expect.any(Number),
          prompt_tokens: expect.any(Number),
          completion_tokens: expect.any(Number),
          end: expect.any(Number),
        },
        metadata: {
          tags: ["seq:step:2"],
          model: "gpt-4o-mini-2024-07-18",
        },
        output: {
          generations: [
            [
              {
                text: expect.any(String), // Generated text
                message: {
                  kwargs: {
                    content: expect.any(String), // Message content
                    additional_kwargs: expect.any(Object),
                    response_metadata: expect.any(Object),
                    tool_calls: expect.any(Array),
                    invalid_tool_calls: expect.any(Array),
                    usage_metadata: expect.any(Object),
                  },
                },
              },
            ],
          ],
          llmOutput: {
            tokenUsage: {
              promptTokens: expect.any(Number),
              completionTokens: expect.any(Number),
              totalTokens: expect.any(Number),
            },
          },
        },
        root_span_id: root_span_id,
        span_parents: [root_span_span_id],
      },
    ]);

    expect(message.content).toEqual(expect.stringContaining("3"));
  });
});

it("should handle streaming LLM calls", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post("https://api.openai.com/v1/chat/completions", async () => {
      const stream = new ReadableStream({
        start(controller) {
          const chunks = CHAT_STREAM_PARROT;

          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n\n"));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Transfer-Encoding": "chunked",
        },
      });
    }),

    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["stream-span-id"]);
    }),
  );

  const prompt = ChatPromptTemplate.fromTemplate(
    `tell me a four word joke about {topic}`,
  );
  const model = new ChatOpenAI({
    model: "gpt-4o-mini-2024-07-18",
    streaming: true,
  });

  const chain = prompt.pipe(model);

  const stream = await chain.stream(
    { topic: "parrot" },
    { callbacks: [handler] },
  );

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "RunnableSequence",
        type: "task",
      },
      input: {
        topic: "parrot",
      },
      metadata: {
        tags: [],
      },
      span_id: root_span_span_id,
      root_span_id,
    },
    {
      span_attributes: { name: "ChatPromptTemplate", type: "task" },
      input: { topic: "parrot" },
      output: expect.objectContaining({
        kwargs: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              kwargs: expect.objectContaining({
                content: "tell me a four word joke about parrot",
              }),
            }),
          ]),
        }),
      }),
      metadata: { tags: ["seq:step:1"] },
      root_span_id,
      span_parents: [root_span_span_id],
    },
    {
      span_attributes: { name: "ChatOpenAI", type: "llm" },
      input: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            kwargs: expect.objectContaining({
              content: "tell me a four word joke about parrot",
            }),
          }),
        ]),
      ]),
      output: expect.objectContaining({
        generations: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                kwargs: expect.objectContaining({
                  content: "Polly wants more crackers!",
                }),
              }),
            }),
          ]),
        ]),
      }),
      metrics: {
        completion_tokens: 6,
        end: expect.any(Number),
        prompt_tokens: 16,
        start: expect.any(Number),
        total_tokens: 22,
      },
      metadata: {
        tags: ["seq:step:2"],
        model: "gpt-4o-mini-2024-07-18",
      },
      root_span_id,
      span_parents: [root_span_span_id],
    },
  ]);

  expect(chunks.length).toBeGreaterThan(0);
});

it("should track time-to-first-token in streaming calls", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post("https://api.openai.com/v1/chat/completions", async () => {
      const stream = new ReadableStream({
        start(controller) {
          const chunks = CHAT_STREAM_PARROT;

          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + "\n\n"));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Transfer-Encoding": "chunked",
        },
      });
    }),

    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["stream-span-id"]);
    }),
  );

  const prompt = ChatPromptTemplate.fromTemplate("Count from 1 to 5.");
  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    streaming: true,
  });

  const chain = prompt.pipe(model);

  const chunks = [];
  const stream = await chain.stream({}, { callbacks: [handler] });
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  // Verify we got streaming chunks
  expect(chunks.length).toBeGreaterThan(0);

  await flush();

  const { spans } = logsToSpans(logs);

  // Find the LLM span
  const llmSpan = spans.find(
    (s) =>
      s.span_attributes?.name === "ChatOpenAI" &&
      s.span_attributes?.type === "llm",
  );

  expect(llmSpan).toBeDefined();
  expect(llmSpan?.metrics).toMatchObject({
    time_to_first_token: expect.any(Number),
    prompt_tokens: expect.any(Number),
    completion_tokens: expect.any(Number),
    total_tokens: expect.any(Number),
  });

  // Verify TTFT is a reasonable value (positive and less than total time)
  expect(llmSpan?.metrics?.time_to_first_token).toBeGreaterThan(0);
});

it("should handle multi-step chains with memory", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post("https://api.openai.com/v1/chat/completions", () => {
      return HttpResponse.json(CHAT_CHAIN_MEMORY);
    }),

    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["memory-span-id"]);
    }),
  );

  const prompt = ChatPromptTemplate.fromTemplate(`{history} User: {input}`);
  const model = new ChatOpenAI({
    model: "gpt-4o-mini-2024-07-18",
  });

  const chain = prompt.pipe(model);

  const memory = { history: "Assistant: Hello! How can I assist you today?" };
  await chain.invoke(
    { input: "What's your name?", ...memory },
    { callbacks: [handler], tags: ["test"] },
  );

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  debugger;

  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "RunnableSequence",
        type: "task",
      },
      input: {
        history: "Assistant: Hello! How can I assist you today?",
        input: "What's your name?",
      },
      metadata: {
        tags: ["test"],
      },
      span_id: root_span_span_id,
      root_span_id,
    },
    {
      span_attributes: { name: "ChatPromptTemplate", type: "task" },
      input: {
        history: "Assistant: Hello! How can I assist you today?",
        input: "What's your name?",
      },
      output: expect.objectContaining({
        kwargs: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              kwargs: expect.objectContaining({
                content:
                  "Assistant: Hello! How can I assist you today? User: What's your name?",
              }),
            }),
          ]),
        }),
      }),
      metadata: { tags: ["seq:step:1", "test"] },
      root_span_id,
      span_parents: [root_span_span_id],
    },
    {
      span_attributes: { name: "ChatOpenAI", type: "llm" },
      input: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            kwargs: expect.objectContaining({
              content:
                "Assistant: Hello! How can I assist you today? User: What's your name?",
            }),
          }),
        ]),
      ]),
      output: expect.objectContaining({
        generations: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                kwargs: expect.objectContaining({
                  content: expect.stringContaining("Assistant"),
                }),
              }),
            }),
          ]),
        ]),
      }),
      metrics: {
        completion_tokens: expect.any(Number),
        end: expect.any(Number),
        prompt_tokens: expect.any(Number),
        start: expect.any(Number),
        total_tokens: expect.any(Number),
      },
      metadata: {
        tags: ["seq:step:2", "test"],
        model: "gpt-4o-mini-2024-07-18",
      },
      root_span_id,
      span_parents: [root_span_span_id],
    },
  ]);
});

it("should handle tool/agent usage", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post("https://api.openai.com/v1/chat/completions", async () => {
      return HttpResponse.json(CHAT_TOOL_CALCULATOR);
    }),

    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["tool-span-id"]);
    }),
  );

  const llm = new ChatOpenAI({
    model: "gpt-4o-mini-2024-07-18",
  });

  const calculatorSchema = z.object({
    operation: z
      .enum(["add", "subtract", "multiply", "divide"])
      .describe("The type of operation to execute."),
    number1: z.number().describe("The first number to operate on."),
    number2: z.number().describe("The second number to operate on."),
  });

  const calculatorTool = tool(
    ({ operation, number1, number2 }) => {
      // Functions must return strings
      if (operation === "add") {
        return `${number1 + number2}`;
      } else if (operation === "subtract") {
        return `${number1 - number2}`;
      } else if (operation === "multiply") {
        return `${number1 * number2}`;
      } else if (operation === "divide") {
        return `${number1 / number2}`;
      } else {
        throw new Error("Invalid operation.");
      }
    },
    {
      name: "calculator",
      description: "Can perform mathematical operations.",
      schema: calculatorSchema,
    },
  );

  const llmWithTools = llm.bindTools([calculatorTool]);

  await llmWithTools.invoke("What is 3 * 12", {
    callbacks: [handler],
  });

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  debugger;

  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "ChatOpenAI",
        type: "llm",
      },
      input: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            kwargs: expect.objectContaining({
              content: "What is 3 * 12",
            }),
          }),
        ]),
      ]),
      output: expect.objectContaining({
        generations: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                kwargs: expect.objectContaining({
                  tool_calls: expect.arrayContaining([
                    expect.objectContaining({
                      name: "calculator",
                      args: {
                        operation: "multiply",
                        number1: 3,
                        number2: 12,
                      },
                    }),
                  ]),
                }),
              }),
            }),
          ]),
        ]),
      }),
      metrics: {
        completion_tokens: expect.any(Number),
        end: expect.any(Number),
        prompt_tokens: expect.any(Number),
        start: expect.any(Number),
        total_tokens: expect.any(Number),
      },
      metadata: {
        model: "gpt-4o-mini-2024-07-18",
        tags: [],
      },
      span_id: root_span_span_id,
      root_span_id,
    },
  ]);
});

it("should handle parallel runnable execution", async () => {
  const logs: LogsRequest[] = [];

  const calls = [
    HttpResponse.json(CHAT_BEAR_JOKE),
    HttpResponse.json(CHAT_BEAR_POEM),
  ];

  server.use(
    http.post("https://api.openai.com/v1/chat/completions", () => {
      return calls.shift() || HttpResponse.json({ ok: false }, { status: 500 });
    }),

    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["parallel-span-id"]);
    }),
  );

  const model = new ChatOpenAI({ model: "gpt-4o-mini-2024-07-18" });

  const jokeChain = PromptTemplate.fromTemplate(
    "Tell me a joke about {topic}",
  ).pipe(model);
  const poemChain = PromptTemplate.fromTemplate(
    "write a 2-line poem about {topic}",
  ).pipe(model);

  const mapChain = RunnableMap.from({
    joke: jokeChain,
    poem: poemChain,
  });

  await mapChain.invoke({ topic: "bear" }, { callbacks: [handler] });

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  // Check that we have the expected structure
  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "RunnableMap",
        type: "task",
      },
      input: {
        input: {
          topic: "bear",
        },
      },
      metadata: {
        tags: [],
      },
      span_id: root_span_span_id,
      root_span_id,
    },
    {
      // Updated for LangGraph 1.x API using Annotation
      span_attributes: { name: "RunnableSequence", type: "task" },
      input: { topic: "bear" },
      root_span_id,
      span_parents: [root_span_span_id],
    },
    {
      span_attributes: { name: "RunnableSequence", type: "task" },
      input: { topic: "bear" },
      root_span_id,
      span_parents: [root_span_span_id],
    },
    // Additional spans for the prompts and models
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.anything(),
  ]);
});

it("should handle LangGraph state management", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post("https://api.openai.com/v1/chat/completions", async () => {
      return HttpResponse.json(CHAT_SAY_HELLO);
    }),

    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["graph-span-id"]);
    }),
  );

  const GraphState = Annotation.Root({
    message: Annotation<string>({
      reducer: (_, y) => y,
      default: () => "",
    }),
  });

  type State = typeof GraphState.State;
  type StateUpdate = typeof GraphState.Update;

  const model = new ChatOpenAI({
    model: "gpt-4o-mini-2024-07-18",
    callbacks: [handler],
  });

  async function sayHello(_: State): Promise<StateUpdate> {
    const res = await model.invoke("Say hello");
    return { message: typeof res.content === "string" ? res.content : "" };
  }

  function sayBye(_: State): StateUpdate {
    console.log(`From the 'sayBye' node: Bye world!`);
    return {};
  }

  const graphBuilder = new StateGraph(GraphState) // Add our nodes to the Graph
    .addNode("sayHello", sayHello)
    .addNode("sayBye", sayBye) // Add the edges between nodes
    .addEdge(START, "sayHello")
    .addEdge("sayHello", "sayBye")
    .addEdge("sayBye", END);

  const helloWorldGraph = graphBuilder.compile();

  await helloWorldGraph.invoke({}, { callbacks: [handler] });

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "LangGraph",
        type: "task",
      },
      input: {},
      span_id: root_span_span_id,
      root_span_id,
    },
    {
      span_attributes: { name: "sayHello", type: "task" },
      root_span_id,
      span_parents: [root_span_span_id],
    },
    {
      span_attributes: { name: "ChatOpenAI", type: "llm" },
      input: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            kwargs: expect.objectContaining({
              content: "Say hello",
            }),
          }),
        ]),
      ]),
      output: expect.objectContaining({
        generations: expect.anything(),
      }),
      root_span_id,
      span_parents: expect.anything(),
    },
    {
      span_attributes: { name: "sayBye", type: "task" },
      root_span_id,
      span_parents: [root_span_span_id],
    },
  ]);
});

it("should have correctly typed constructor parameters", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post("https://api.openai.com/v1/chat/completions", () => {
      return HttpResponse.json(CHAT_MATH);
    }),

    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["4bc6305f-2175-4481-bc84-7c55a456b7ea"]);
    }),
  );

  const handler = new BraintrustCallbackHandler({
    logger: NOOP_SPAN,
  });

  handler.handleLLMStart(
    {
      name: "test",
      lc: 1,
      type: "secret",
      id: ["test"],
    },
    ["test"],
    "test",
    "test",
  );

  await flush();

  expect(logs).toEqual([]);
});

it("should handle chain inputs/outputs with null/undefined values", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["null-span-id"]);
    }),
  );

  // Test chain with null/undefined inputs
  await handler.handleChainStart(
    { id: ["TestChain"], lc: 1, type: "not_implemented" },
    { input1: "value1", input2: null, input3: undefined },
    "run-1",
    undefined,
    ["test"],
  );

  await handler.handleChainEnd(
    { output1: "value1", output2: null, output3: undefined },
    "run-1",
    undefined,
    ["test"],
  );

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "TestChain",
        type: "task",
      },
      input: {
        input1: "value1",
        input2: null,
      },
      output: {
        output1: "value1",
        output2: null,
      },
      metadata: {
        tags: ["test"],
      },
      span_id: root_span_span_id,
      root_span_id,
    },
  ]);
});

it("should handle agent action and agent end callbacks", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["agent-span-id"]);
    }),
  );

  const agentAction = {
    tool: "calculator",
    toolInput: { operation: "multiply", a: 3, b: 12 },
    log: "Invoking calculator with multiply 3 * 12",
  };

  const agentFinish = {
    returnValues: { output: "The result is 36" },
    log: "Final answer: 36",
  };

  await handler.handleAgentAction(agentAction, "agent-run-1", undefined, [
    "agent-test",
  ]);

  await handler.handleAgentEnd(agentFinish, "agent-run-1", undefined, [
    "agent-test",
  ]);

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "calculator",
        type: "llm",
      },
      input: {
        tool: "calculator",
        toolInput: { operation: "multiply", a: 3, b: 12 },
        log: "Invoking calculator with multiply 3 * 12",
      },
      output: {
        returnValues: { output: "The result is 36" },
        log: "Final answer: 36",
      },
      metadata: {
        tags: ["agent-test"],
      },
      span_id: root_span_span_id,
      root_span_id,
    },
  ]);
});

it("should handle agent action with string toolInput", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["agent-string-span-id"]);
    }),
  );

  const agentAction = {
    tool: "search",
    toolInput: "What is the weather in Paris?",
    log: "Searching for weather information",
  };

  const agentFinish = {
    returnValues: { output: "It is sunny and 22 degrees in Paris" },
    log: "Search complete",
  };

  await handler.handleAgentAction(agentAction, "agent-run-2", undefined, [
    "search-test",
  ]);

  await handler.handleAgentEnd(agentFinish, "agent-run-2", undefined, [
    "search-test",
  ]);

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  expect(spans).toMatchObject([
    {
      span_attributes: {
        name: "search",
        type: "llm",
      },
      input: {
        tool: "search",
        toolInput: "What is the weather in Paris?",
        log: "Searching for weather information",
      },
      output: {
        returnValues: { output: "It is sunny and 22 degrees in Paris" },
        log: "Search complete",
      },
      metadata: {
        tags: ["search-test"],
      },
      span_id: root_span_span_id,
      root_span_id,
    },
  ]);
});

it("should handle nested agent action with parent run id", async () => {
  const logs: LogsRequest[] = [];

  server.use(
    http.post(/.+logs/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      return HttpResponse.json(["nested-agent-span-id"]);
    }),
  );

  await handler.handleChainStart(
    { id: ["AgentExecutor"], lc: 1, type: "not_implemented" },
    { input: "Calculate 3 * 12" },
    "parent-run-1",
    undefined,
    ["agent-executor"],
  );

  const agentAction = {
    tool: "calculator",
    toolInput: { a: 3, b: 12, operation: "multiply" },
    log: "Using calculator tool",
  };

  await handler.handleAgentAction(
    agentAction,
    "child-agent-run",
    "parent-run-1",
    ["agent-action"],
  );

  const agentFinish = {
    returnValues: { output: "36" },
    log: "Calculation complete",
  };

  await handler.handleAgentEnd(agentFinish, "child-agent-run", "parent-run-1", [
    "agent-action",
  ]);

  await handler.handleChainEnd(
    { output: "The answer is 36" },
    "parent-run-1",
    undefined,
    ["agent-executor"],
  );

  await flush();

  const { spans, root_span_id, root_span_span_id } = logsToSpans(logs);

  expect(spans.length).toBe(2);

  expect(spans[0]).toMatchObject({
    span_attributes: {
      name: "AgentExecutor",
      type: "task",
    },
    input: { input: "Calculate 3 * 12" },
    output: { output: "The answer is 36" },
    metadata: {
      tags: ["agent-executor"],
    },
    span_id: root_span_span_id,
    root_span_id,
  });

  expect(spans[1]).toMatchObject({
    span_attributes: {
      name: "calculator",
      type: "llm",
    },
    input: {
      tool: "calculator",
      toolInput: { a: 3, b: 12, operation: "multiply" },
      log: "Using calculator tool",
    },
    output: {
      returnValues: { output: "36" },
      log: "Calculation complete",
    },
    metadata: {
      tags: ["agent-action"],
    },
    root_span_id,
    span_parents: [root_span_span_id],
  });
});

it("should extract prompt caching tokens from Anthropic response", async () => {
  const logs: LogsRequest[] = [];

  const ANTHROPIC_RESPONSE_WITH_CACHE = {
    model: "claude-sonnet-4-5-20250929",
    id: "msg_01PKL7azhWzdzdXC5yojHG6V",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: 'The first type of testing mentioned is **Unit Testing**, which is described as "Testing individual components or functions in isolation."',
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 14,
      cache_creation_input_tokens: 2042,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
      output_tokens: 27,
      service_tier: "standard",
    },
  };

  const ANTHROPIC_RESPONSE_WITH_CACHE_READ = {
    model: "claude-sonnet-4-5-20250929",
    id: "msg_01PjHqPkFstyG2Bcqum9XKD8",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: 'Based on the document:\n\n1. **First type of testing mentioned:** Unit Testing - described as "Testing individual components or functions in isolation"\n\n2. **Python testing frameworks mentioned:** \n   - pytest (described as "Feature-rich testing framework")\n   - unittest (described as "Built-in Python testing module")',
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 23,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2042,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
      output_tokens: 71,
      service_tier: "standard",
    },
  };

  const anthropicResponses = [
    ANTHROPIC_RESPONSE_WITH_CACHE,
    ANTHROPIC_RESPONSE_WITH_CACHE_READ,
  ];

  server.use(
    http.post("https://api.anthropic.com/v1/messages", ({ request }) => {
      const message = anthropicResponses.shift();
      return HttpResponse.json(message);
    }),

    http.post(/.+logs.+/, async ({ request }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      logs.push((await request.json()) as LogsRequest);
      console.log(logs.slice(-1)[0]);
      return HttpResponse.json(["cache-tokens-span-id"]);
    }),
  );

  const model = new ChatAnthropic({
    model: "claude-sonnet-4-5-20250929",
    anthropicApiKey: "test-key",
  });

  // Use a long system message to simulate cache-eligible content
  const longText = `
# Comprehensive Guide to Software Testing Methods

Software testing is a critical component of the software development lifecycle.
This guide covers various testing methodologies, best practices, and tools.

## Types of Testing
- Unit Testing: Testing individual components or functions in isolation
- Integration Testing: Testing how components work together
- End-to-End Testing: Testing the entire application flow

## Python Testing Tools
- pytest: Feature-rich testing framework
- unittest: Built-in Python testing module
`.repeat(20); // Repeat to ensure enough tokens for caching

  const messages = [
    new SystemMessage({
      content: [
        {
          type: "text",
          text: longText,
          cache_control: { type: "ephemeral" },
        },
      ],
    }),
    new HumanMessage("What is the first type of testing mentioned?"),
  ];

  // First invocation - should create cache
  await model.invoke(messages, { callbacks: [handler] });

  await flush();

  const { spans: firstSpans } = logsToSpans(logs);
  logs.length = 0; // Clear logs for next invocation

  const firstLlmSpan = firstSpans.find(
    (s) => s.span_attributes?.type === "llm",
  );

  expect(firstLlmSpan).toBeDefined();
  expect(firstLlmSpan?.metrics).toMatchObject({
    prompt_tokens: 14,
    completion_tokens: 27,
  });

  console.log(firstLlmSpan?.metrics);

  // After fix: should have cache creation tokens
  expect(firstLlmSpan?.metrics?.prompt_cache_creation_tokens).toBe(2042);

  // Second invocation - should read from cache
  await model.invoke(
    [
      ...messages,
      new HumanMessage("What testing framework is mentioned for Python?"),
    ],
    { callbacks: [handler] },
  );

  await flush();

  const { spans: secondSpans } = logsToSpans(logs);

  const secondLlmSpan = secondSpans.find(
    (s) => s.span_attributes?.type === "llm",
  );

  expect(secondLlmSpan).toBeDefined();
  expect(secondLlmSpan?.metrics).toMatchObject({
    prompt_tokens: 23,
    completion_tokens: 71,
  });

  // After fix: should have cache read tokens
  expect(secondLlmSpan?.metrics?.prompt_cached_tokens).toBe(2042);
});
