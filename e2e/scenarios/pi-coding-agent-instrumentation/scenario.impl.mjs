import { wrapPiCodingAgentSDK } from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "pi-coding-agent-root";
export const SCENARIO_NAME = "pi-coding-agent-instrumentation";

async function runPiCodingAgentScenario({ decorateSDK, sdk }) {
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const useFakeStream = process.env.PI_CODING_AGENT_FAKE_STREAM === "true";
  const {
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
    createAgentSession,
  } = instrumentedSDK;

  let authStorage;
  let modelRuntime;
  let modelRegistry;
  if (ModelRuntime) {
    modelRuntime = await ModelRuntime.create({ modelsPath: null });
    if (!useFakeStream) {
      modelRuntime.registerProvider("anthropic", {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      });
    }
    await modelRuntime.setRuntimeApiKey(
      "anthropic",
      useFakeStream
        ? "pi-coding-agent-e2e-placeholder"
        : process.env.ANTHROPIC_API_KEY,
    );
    modelRegistry = new ModelRegistry(modelRuntime);
  } else {
    authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
    modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider("anthropic", {
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    });
  }
  const model = modelRegistry.find("anthropic", "claude-haiku-4-5");
  if (!model) {
    throw new Error("Expected Pi Coding Agent Anthropic model");
  }
  const cwd = process.cwd();
  const resourceLoader = new DefaultResourceLoader({
    agentDir: cwd,
    cwd,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  let session;
  await runTracedScenario({
    callback: async () => {
      await runOperation(
        "pi-coding-agent-prompt-operation",
        "prompt",
        async () => {
          const result = await createAgentSession({
            cwd,
            model,
            ...(modelRuntime
              ? { modelRuntime }
              : { authStorage, modelRegistry }),
            resourceLoader,
            sessionManager: SessionManager.inMemory(cwd),
            thinkingLevel: "off",
            tools: ["bash"],
          });
          session = result.session;
          if (useFakeStream) {
            let streamCallCount = 0;
            session.agent.streamFunction = async (streamModel) => {
              streamCallCount += 1;
              const message = {
                api: "anthropic-messages",
                content:
                  streamCallCount === 1
                    ? [
                        {
                          arguments: { command: "printf pi_tool_ok" },
                          id: "tool-call-1",
                          name: "bash",
                          type: "toolCall",
                        },
                      ]
                    : [
                        {
                          text: "PI_CODING_AGENT_OK pi_tool_ok",
                          type: "text",
                        },
                      ],
                model: streamModel.id,
                provider: streamModel.provider,
                role: "assistant",
                stopReason: streamCallCount === 1 ? "toolUse" : "stop",
                timestamp: Date.now(),
                usage: {
                  cacheRead: 0,
                  cacheWrite: 0,
                  input: 5,
                  output: 3,
                  totalTokens: 8,
                },
              };
              return {
                async *[Symbol.asyncIterator]() {
                  yield { message, type: "done" };
                },
                async result() {
                  return message;
                },
              };
            };
          }
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
