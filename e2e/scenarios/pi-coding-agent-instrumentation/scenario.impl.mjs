import { startSpan, wrapPiCodingAgentSDK } from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "pi-coding-agent-root";
export const SCENARIO_NAME = "pi-coding-agent-instrumentation";
export const TOOL_CHILD_SPAN_NAME = "pi-tool-child";

async function runPiCodingAgentScenario({ decorateSDK, sdk }) {
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const provider = process.env.PI_CODING_AGENT_PROVIDER ?? "anthropic";
  const modelId = provider === "openai" ? "gpt-5-nano" : "claude-haiku-4-5";
  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY;
  const baseUrl =
    provider === "openai"
      ? process.env.OPENAI_BASE_URL
      : process.env.ANTHROPIC_BASE_URL;
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
    modelRuntime.registerProvider(provider, { baseUrl });
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
    modelRegistry = new ModelRegistry(modelRuntime);
  } else {
    authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
    modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider("anthropic", {
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    });
  }
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Expected Pi Coding Agent ${provider} model ${modelId}`);
  }
  const cwd = process.cwd();
  const resourceLoader = new DefaultResourceLoader({
    agentDir: cwd,
    cwd,
    noContextFiles: true,
    noSkills: true,
    ...(provider === "openai"
      ? {
          systemPrompt: "You are a coding assistant. Use tools when requested.",
        }
      : {}),
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
          const bashTool = session.agent.state.tools.find(
            (tool) => tool.name === "bash",
          );
          if (!bashTool?.execute) {
            throw new Error("Expected Pi Coding Agent bash tool executor");
          }
          const executeBashTool = bashTool.execute;
          bashTool.execute = async function (...args) {
            await Promise.resolve();
            const childSpan = startSpan({ name: TOOL_CHILD_SPAN_NAME });
            try {
              return await Reflect.apply(executeBashTool, this, args);
            } finally {
              childSpan.end();
            }
          };
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
