import {
  failOpenAIAgentsTrace,
  startOpenAIAgentsTrace,
  updateOpenAIAgentsTrace,
} from "braintrust";
import { runMain, runTracedScenario } from "../../helpers/provider-runtime.mjs";
import {
  CORRELATION_ID,
  CORRELATION_KEY,
  FINAL_OUTPUT,
  INPUT,
  MODEL_NAME,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

export async function runOpenAIAgentsAPIInstrumentationScenario() {
  const openAIPackageName =
    process.env.OPENAI_AGENTS_API_PACKAGE_NAME ?? "openai-agents-api-v7-latest";
  const { default: OpenAI } = await import(openAIPackageName);
  const client = new OpenAI();
  const params = {
    agent: {
      instructions:
        "You must use web search exactly once before answering. After searching, answer exactly: Sunny in Vienna",
      model: MODEL_NAME,
      reasoning: { effort: "none" },
      tools: [{ type: "web_search" }],
    },
    environment: { type: "none" },
    input: INPUT,
    metadata: { [CORRELATION_KEY]: CORRELATION_ID },
    stream: true,
  };

  await runTracedScenario({
    callback: async () => {
      let traceToken = startOpenAIAgentsTrace(params);
      const events = await client.beta.agents.sessions.create(params);
      let finalOutput = "";
      let metadataObserved = false;
      let webSearchObserved = false;
      const seenEventTypes = [];
      const timeout = setTimeout(
        () =>
          events.controller.abort(
            new Error(
              `OpenAI Agents API stream timed out after events: ${seenEventTypes.join(", ")}`,
            ),
          ),
        process.env.BRAINTRUST_E2E_DEBUG_AGENTS === "1" ? 60_000 : 120_000,
      );
      try {
        for await (const event of events) {
          seenEventTypes.push(event.type);
          traceToken = await updateOpenAIAgentsTrace(traceToken, event);
          if (
            "session" in event &&
            event.session.metadata?.[CORRELATION_KEY] === CORRELATION_ID
          ) {
            metadataObserved = true;
          }
          if (
            !webSearchObserved &&
            event.type === "agent.session.turn.item.added" &&
            event.item.type === "web_search_call"
          ) {
            webSearchObserved = true;
          } else if (
            event.type === "agent.session.turn.item.done" &&
            event.item.type === "message" &&
            event.item.phase === "final_answer"
          ) {
            finalOutput = event.item.content.map((part) => part.text).join("");
          }
          if (
            event.type === "agent.session.turn.completed" ||
            event.type === "agent.session.turn.failed" ||
            event.type === "agent.session.turn.cancelled"
          ) {
            break;
          }
        }
      } catch (error) {
        traceToken = await failOpenAIAgentsTrace(traceToken, error);
        if (events.controller.signal.reason instanceof Error) {
          throw events.controller.signal.reason;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        events.controller.abort();
      }
      if (!webSearchObserved) {
        throw new Error("OpenAI Agents API did not use web search");
      }
      if (!metadataObserved) {
        throw new Error("OpenAI Agents API did not preserve session metadata");
      }
      if (!finalOutput.includes(FINAL_OUTPUT)) {
        throw new Error(`Unexpected OpenAI Agents API output: ${finalOutput}`);
      }
    },
    flushCount: 2,
    flushDelayMs: 10,
    metadata: { scenario: SCENARIO_NAME },
    projectNameBase: "e2e-openai-agents-api-instrumentation",
    rootName: ROOT_NAME,
  });
}

runMain(runOpenAIAgentsAPIInstrumentationScenario);
