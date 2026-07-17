import { CallbackManager } from "@langchain/core/callbacks/manager";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { flush as flushBraintrustLogs } from "braintrust";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { BraintrustCallbackHandler } from "./BraintrustCallbackHandler";
import { CHAT_MATH } from "./BraintrustCallbackHandler.fixtures";
import { clearGlobalHandler, setGlobalHandler } from "./setGlobalHandler";
import { server } from "./test/setup";
import { LogsRequest } from "./test/types";
import { logsToSpans, withLogging } from "./test/utils";

const handler = withLogging(new BraintrustCallbackHandler({ debug: true }));

describe("setGlobalHandler", () => {
  afterEach(() => {
    clearGlobalHandler();
  });

  it("should register the BraintrustCallbackHandler", async () => {
    setGlobalHandler(handler);

    // Make sure the handler is registered in the LangChain.js library.
    const manager = CallbackManager.configure();
    expect(
      manager?.handlers.filter(
        (handler) => handler instanceof BraintrustCallbackHandler,
      )[0],
    ).toBe(handler);

    const logs: LogsRequest[] = [];

    // Intercept calls to confirm our tracing is working.
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

    // Here's what a typical user would do.
    const prompt = ChatPromptTemplate.fromTemplate(`What is 1 + {number}?`);
    const model = new ChatOpenAI({
      model: "gpt-4o-mini-2024-07-18",
    });

    const chain = prompt.pipe(model);

    const message = await chain.invoke({ number: "2" });

    // Not normally needed by users, but we need it for our tests.
    await flushBraintrustLogs();

    const { spans, trace_id, root_span_id } = logsToSpans(logs);

    // Spans would be empty if the handler was not registered, let's make sure it logged what we expect.
    expect(spans).toMatchObject([
      {
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
        span_id: root_span_id,
        root_span_id: trace_id,
      },
      {
        span_attributes: { name: "ChatPromptTemplate", type: "task" },
        input: { number: "2" },
        output: expect.objectContaining({
          kwargs: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({
                kwargs: expect.objectContaining({
                  content: "What is 1 + 2?",
                }),
              }),
            ]),
          }),
        }),
        metadata: { tags: ["seq:step:1"] },
        root_span_id: trace_id,
        span_parents: [root_span_id],
      },
      {
        span_attributes: { name: "ChatOpenAI", type: "llm" },
        input: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              kwargs: expect.objectContaining({
                content: "What is 1 + 2?",
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
                    content: "1 + 2 equals 3.",
                  }),
                }),
              }),
            ]),
          ]),
        }),
        metrics: {
          completion_tokens: 8,
          end: expect.any(Number),
          prompt_tokens: 15,
          start: expect.any(Number),
          tokens: 23,
        },
        metadata: {
          tags: ["seq:step:2"],
          model: "gpt-4o-mini-2024-07-18",
        },
        root_span_id: trace_id,
        span_parents: [root_span_id],
      },
    ]);

    expect(message.content).toBe("1 + 2 equals 3.");
  });
});
