import { BraintrustCallbackHandler } from "@braintrust/langchain-js";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { runMain } from "../../helpers/scenario-runtime";

const OPENAI_MODEL = "gpt-4o-mini";

runMain(async () => {
  await runTracedScenario({
    callback: async () => {
      // The handler attaches as a child of the current traced span via
      // the parent option resolved by runTracedScenario.
      const handler = new BraintrustCallbackHandler();

      await runOperation("langchain-invoke-operation", "invoke", async () => {
        const model = new ChatOpenAI({
          model: OPENAI_MODEL,
          maxTokens: 16,
          temperature: 0,
          callbacks: [handler],
        });
        await model.invoke([new HumanMessage("Reply with exactly OK.")]);
      });

      await runOperation("langchain-chain-operation", "chain", async () => {
        const model = new ChatOpenAI({
          model: OPENAI_MODEL,
          maxTokens: 32,
          temperature: 0,
        });
        const prompt = ChatPromptTemplate.fromTemplate(
          "Reply with the single word {word} and nothing else.",
        );
        const chain = prompt.pipe(model);
        await chain.invoke({ word: "PARIS" }, { callbacks: [handler] });
      });

      await runOperation("langchain-stream-operation", "stream", async () => {
        const model = new ChatOpenAI({
          model: OPENAI_MODEL,
          maxTokens: 32,
          temperature: 0,
          streaming: true,
          callbacks: [handler],
        });
        const stream = await model.stream([
          new HumanMessage(
            "Count from 1 to 3 and include the words one two three.",
          ),
        ]);
        await collectAsync(stream);
      });

      await runOperation("langchain-tool-operation", "tool", async () => {
        const getWeatherTool = new DynamicStructuredTool({
          name: "get_weather",
          description: "Get the current weather in a given location",
          schema: z.object({
            location: z
              .string()
              .describe("The city and state or city and country"),
          }),
          func: async ({ location }) => {
            return JSON.stringify({
              condition: "sunny",
              location,
              temperatureC: 22,
            });
          },
        });

        const model = new ChatOpenAI({
          model: OPENAI_MODEL,
          maxTokens: 128,
          temperature: 0,
          callbacks: [handler],
        });
        const modelWithTools = model.bindTools([getWeatherTool]);
        await modelWithTools.invoke(
          "Use the get_weather tool for Paris, France. Do not answer from memory.",
        );
      });

      await runOperation(
        "langchain-tool-result-operation",
        "tool-result",
        async () => {
          const calculateTool = new DynamicStructuredTool({
            name: "calculate",
            description: "Perform a mathematical calculation",
            schema: z.object({
              operation: z.enum(["add", "subtract", "multiply", "divide"]),
              a: z.number(),
              b: z.number(),
            }),
            func: async ({ operation, a, b }) => {
              const ops = {
                add: a + b,
                subtract: a - b,
                multiply: a * b,
                divide: b !== 0 ? a / b : 0,
              };
              return String(ops[operation]);
            },
          });

          const model = new ChatOpenAI({
            model: OPENAI_MODEL,
            maxTokens: 128,
            temperature: 0,
            callbacks: [handler],
          });
          const modelWithTools = model.bindTools([calculateTool]);

          const firstResult = await modelWithTools.invoke(
            "What is 127 multiplied by 49? Use the calculate tool.",
          );

          if (firstResult.tool_calls && firstResult.tool_calls.length > 0) {
            const toolCall = firstResult.tool_calls[0];
            const result = String(127 * 49);

            await modelWithTools.invoke([
              new HumanMessage(
                "What is 127 multiplied by 49? Use the calculate tool.",
              ),
              new AIMessage({ content: "", tool_calls: [toolCall] }),
              new ToolMessage({
                content: result,
                tool_call_id: toolCall.id,
              }),
            ]);
          }
        },
      );
    },
    metadata: {
      scenario: "wrap-langchain-js-traces",
    },
    projectNameBase: "e2e-wrap-langchain",
    rootName: "langchain-wrapper-root",
  });
});
