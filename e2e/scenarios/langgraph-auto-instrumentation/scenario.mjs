const langchainCorePackageName =
  process.env.LANGCHAIN_CORE_PACKAGE_NAME ?? "langchain-core-v1-latest";
const langgraphPackageName =
  process.env.LANGGRAPH_PACKAGE_NAME ?? "langchain-langgraph-v1-latest";
const langchainOpenAIPackageName =
  process.env.LANGCHAIN_OPENAI_PACKAGE_NAME ?? "langchain-openai-v1-latest";
const { HumanMessage } = await import(`${langchainCorePackageName}/messages`);
const { Annotation, END, START, StateGraph } = await import(
  langgraphPackageName
);
const { ChatOpenAI } = await import(langchainOpenAIPackageName);
import { runMain, runTracedScenario } from "../../helpers/provider-runtime.mjs";
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

const OPENAI_MODEL = "gpt-5-nano";

runMain(async () => {
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
        maxTokens: 4_000,
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
