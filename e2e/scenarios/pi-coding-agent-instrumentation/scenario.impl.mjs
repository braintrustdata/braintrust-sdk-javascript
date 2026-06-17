import { wrapPiCodingAgentSDK } from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "pi-coding-agent-root";
export const SCENARIO_NAME = "pi-coding-agent-instrumentation";

async function runPiCodingAgentScenario({ decorateSDK, sdk }) {
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const { AuthStorage, ModelRegistry, SessionManager, createAgentSession } =
    instrumentedSDK;

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("anthropic", {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  });
  const model = modelRegistry.find("anthropic", "claude-haiku-4-5");
  if (!model) {
    throw new Error("Expected Pi Coding Agent Anthropic model");
  }

  let session;
  await runTracedScenario({
    callback: async () => {
      await runOperation(
        "pi-coding-agent-prompt-operation",
        "prompt",
        async () => {
          const result = await createAgentSession({
            authStorage,
            cwd: process.cwd(),
            model,
            modelRegistry,
            sessionManager: SessionManager.inMemory(process.cwd()),
            thinkingLevel: "off",
            tools: ["bash"],
          });
          session = result.session;
          await session.prompt(
            "Use the bash tool to run `printf pi_tool_ok` exactly once, then reply with exactly PI_CODING_AGENT_OK and include the command output.",
            { expandPromptTemplates: false, source: "rpc" },
          );
        },
      );
    },
    flushCount: 2,
    flushDelayMs: 250,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-pi-coding-agent-instrumentation",
    rootName: ROOT_NAME,
  });

  session?.dispose?.();
}

export async function runWrappedPiCodingAgentInstrumentation(sdk) {
  await runPiCodingAgentScenario({
    decorateSDK: wrapPiCodingAgentSDK,
    sdk,
  });
}

export async function runAutoPiCodingAgentInstrumentation(sdk) {
  await runPiCodingAgentScenario({
    sdk,
  });
}
