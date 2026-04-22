import { HumanMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { runMain, runTracedScenario } from "../../helpers/provider-runtime.mjs";
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

const OPENAI_MODEL = "gpt-4o-mini-2024-07-18";

runMain(async () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for this e2e scenario");
  }

  await runTracedScenario({
    callback: async () => {
      const GraphState = Annotation.Root({
        message: Annotation({
          reducer: (_, value) => value,
          default: () => "",
        }),
      });

      const model = new ChatOpenAI({
        model: OPENAI_MODEL,
        maxTokens: 24,
        temperature: 0,
      });

      async function sayHello() {
        const response = await model.invoke([
          new HumanMessage("Reply with exactly: hello from langgraph"),
        ]);

        return {
          message: typeof response.content === "string" ? response.content : "",
        };
      }

      function sayBye() {
        return {};
      }

      const graph = new StateGraph(GraphState)
        .addNode("sayHello", sayHello)
        .addNode("sayBye", sayBye)
        .addEdge(START, "sayHello")
        .addEdge("sayHello", "sayBye")
        .addEdge("sayBye", END)
        .compile();

      await graph.invoke({});
    },
    flushCount: 2,
    flushDelayMs: 100,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-langgraph-auto-instrumentation",
    rootName: ROOT_NAME,
  });
});
