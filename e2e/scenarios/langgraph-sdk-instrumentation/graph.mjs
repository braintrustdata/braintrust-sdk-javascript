import { ChatOpenAI } from "@langchain/openai";
import {
  END,
  START,
  StateGraph,
  MessagesAnnotation,
  interrupt,
} from "@langchain/langgraph";

// GPT-5 models only support the default temperature, and their output
// budget includes reasoning tokens.
const model = new ChatOpenAI({
  model: "gpt-5.4-nano",
  maxTokens: 512,
  maxRetries: 0,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
});

async function generate(state) {
  return { messages: [await model.invoke(state.messages)] };
}

export const agent = new StateGraph(MessagesAnnotation)
  .addNode("agent", generate)
  .addEdge(START, "agent")
  .addEdge("agent", END)
  .compile();

export const approval = new StateGraph(MessagesAnnotation)
  .addNode("approve", () => {
    interrupt("Approve the model call?");
    return {};
  })
  .addNode("agent", generate)
  .addEdge(START, "approve")
  .addEdge("approve", "agent")
  .addEdge("agent", END)
  .compile();

// Exercise the real server's error serialization without a flaky provider error.
export const failing = new StateGraph(MessagesAnnotation)
  .addNode("fail", () => {
    throw new Error("Agent failed");
  })
  .addEdge(START, "fail")
  .addEdge("fail", END)
  .compile();
