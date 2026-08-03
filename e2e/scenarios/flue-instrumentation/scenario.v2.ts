import { openaiProvider } from "pi-ai-v2/providers/openai";
import {
  braintrustFlueInstrumentation,
  flush,
  initLogger,
  traced,
} from "braintrust";
import * as v from "valibot";

const SCENARIO_NAME = "flue-instrumentation";
const MODEL = "openai/gpt-5.6-luna";
const runtimePackageName =
  process.env.FLUE_RUNTIME_PACKAGE_NAME ?? "flue-runtime-v2-latest";
const [{ defineTool, init, instrument, useModel, useTool }, { start }] =
  await Promise.all([
    import(runtimePackageName),
    import(`${runtimePackageName}/node`),
  ]);

initLogger({
  projectName:
    process.env.BRAINTRUST_E2E_PROJECT_NAME ?? "e2e-flue-v2-instrumentation",
});

const lookup = defineTool({
  name: "lookup",
  description: "Return the deterministic Flue instrumentation result.",
  input: v.object({ query: v.string() }),
  async run({ data }: { data: { query: string } }) {
    await traced(
      async (span) => {
        span.log({ output: "lookup-active" });
      },
      {
        name: "flue.toolCurrentProbe",
        event: { metadata: { scenario: SCENARIO_NAME } },
      },
    );
    return {
      output: {
        framework: "flue",
        query: data.query,
        version: 2,
      },
    };
  },
});

function InstrumentedAgent() {
  useModel(MODEL, { thinkingLevel: "low" });
  useTool(lookup);
  return [
    "Call the lookup tool exactly once with query Flue 2 instrumentation.",
    "Then reply with exactly PROMPT_DONE.",
  ].join(" ");
}

const disposeInstrumentation = instrument(braintrustFlueInstrumentation());
const openai = openaiProvider();
const openAIBaseUrl = process.env.OPENAI_BASE_URL;
const provider = openAIBaseUrl
  ? {
      ...openai,
      baseUrl: openAIBaseUrl,
      getModels: () =>
        openai.getModels().map((model) => ({
          ...model,
          baseUrl: openAIBaseUrl,
        })),
    }
  : openai;
const runtime = await start({
  agents: [InstrumentedAgent],
  providers: [provider],
});

try {
  const agent = init(InstrumentedAgent, { id: "braintrust-e2e" });
  const receipt = await agent.dispatch(
    "Exercise Flue 2 tool-use instrumentation and finish with PROMPT_DONE.",
  );
  const reply = await agent.read(receipt);
  if (reply.text !== "PROMPT_DONE") {
    throw new Error(`Unexpected Flue reply: ${reply.text}`);
  }
} finally {
  await runtime.stop();
  await disposeInstrumentation();
  await flush();
}
