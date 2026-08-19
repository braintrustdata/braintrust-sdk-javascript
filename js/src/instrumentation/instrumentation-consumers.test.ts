import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstrumentationIntegrationsConfig } from "./config";

const registrations = vi.hoisted(() => ({
  aiSDK: vi.fn(),
  anthropic: vi.fn(),
  bedrockRuntime: vi.fn(),
  claudeAgentSDK: vi.fn(),
  cloudflareAgents: vi.fn(),
  cloudflareAIChat: vi.fn(),
  cloudflareThink: vi.fn(),
  cohere: vi.fn(),
  cursorSDK: vi.fn(),
  genkit: vi.fn(),
  gitHubCopilot: vi.fn(),
  googleADK: vi.fn(),
  googleGenAI: vi.fn(),
  groq: vi.fn(),
  huggingFace: vi.fn(),
  huggingFaceTransformers: vi.fn(),
  langChain: vi.fn(),
  langSmith: vi.fn(),
  mistral: vi.fn(),
  ollama: vi.fn(),
  openAI: vi.fn(),
  openAIAgents: vi.fn(),
  openAICodex: vi.fn(),
  openRouter: vi.fn(),
  openRouterAgent: vi.fn(),
  piCodingAgent: vi.fn(),
  strandsAgentSDK: vi.fn(),
  voyageAI: vi.fn(),
}));

vi.mock("./providers/ai-sdk-instrumentation", () => ({
  registerAISDKInstrumentation: registrations.aiSDK,
}));
vi.mock("./providers/anthropic-instrumentation", () => ({
  registerAnthropicInstrumentation: registrations.anthropic,
}));
vi.mock("./providers/bedrock-runtime-instrumentation", () => ({
  registerBedrockRuntimeInstrumentation: registrations.bedrockRuntime,
}));
vi.mock("./providers/claude-agent-sdk-instrumentation", () => ({
  registerClaudeAgentSDKInstrumentation: registrations.claudeAgentSDK,
}));
vi.mock("./providers/cloudflare-agents-instrumentation", () => ({
  registerCloudflareAgentsInstrumentation: registrations.cloudflareAgents,
}));
vi.mock("./providers/cloudflare-ai-chat-consumer", () => ({
  registerCloudflareAIChatInstrumentation: registrations.cloudflareAIChat,
}));
vi.mock("./providers/cloudflare-think-instrumentation", () => ({
  registerCloudflareThinkInstrumentation: registrations.cloudflareThink,
}));
vi.mock("./providers/cohere-instrumentation", () => ({
  registerCohereInstrumentation: registrations.cohere,
}));
vi.mock("./providers/cursor-sdk-instrumentation", () => ({
  registerCursorSDKInstrumentation: registrations.cursorSDK,
}));
vi.mock("./providers/genkit-instrumentation", () => ({
  registerGenkitInstrumentation: registrations.genkit,
}));
vi.mock("./providers/github-copilot-instrumentation", () => ({
  registerGitHubCopilotInstrumentation: registrations.gitHubCopilot,
}));
vi.mock("./providers/google-adk-instrumentation", () => ({
  registerGoogleADKInstrumentation: registrations.googleADK,
}));
vi.mock("./providers/google-genai-instrumentation", () => ({
  registerGoogleGenAIInstrumentation: registrations.googleGenAI,
}));
vi.mock("./providers/groq-instrumentation", () => ({
  registerGroqInstrumentation: registrations.groq,
}));
vi.mock("./providers/huggingface-instrumentation", () => ({
  registerHuggingFaceInstrumentation: registrations.huggingFace,
}));
vi.mock("./providers/huggingface-transformers-instrumentation", () => ({
  registerHuggingFaceTransformersInstrumentation:
    registrations.huggingFaceTransformers,
}));
vi.mock("./providers/langchain-instrumentation", () => ({
  registerLangChainInstrumentation: registrations.langChain,
}));
vi.mock("./providers/langsmith-instrumentation", () => ({
  registerLangSmithInstrumentation: registrations.langSmith,
}));
vi.mock("./providers/mistral-instrumentation", () => ({
  registerMistralInstrumentation: registrations.mistral,
}));
vi.mock("./providers/ollama-instrumentation", () => ({
  registerOllamaInstrumentation: registrations.ollama,
}));
vi.mock("./providers/openai-instrumentation", () => ({
  registerOpenAIInstrumentation: registrations.openAI,
}));
vi.mock("./providers/openai-agents-instrumentation", () => ({
  registerOpenAIAgentsInstrumentation: registrations.openAIAgents,
}));
vi.mock("./providers/openai-codex-instrumentation", () => ({
  registerOpenAICodexInstrumentation: registrations.openAICodex,
}));
vi.mock("./providers/openrouter-instrumentation", () => ({
  registerOpenRouterInstrumentation: registrations.openRouter,
}));
vi.mock("./providers/openrouter-agent-instrumentation", () => ({
  registerOpenRouterAgentInstrumentation: registrations.openRouterAgent,
}));
vi.mock("./providers/pi-coding-agent-instrumentation", () => ({
  registerPiCodingAgentInstrumentation: registrations.piCodingAgent,
}));
vi.mock("./providers/strands-agent-sdk-instrumentation", () => ({
  registerStrandsAgentSDKInstrumentation: registrations.strandsAgentSDK,
}));
vi.mock("./providers/voyageai-instrumentation", () => ({
  registerVoyageAIInstrumentation: registrations.voyageAI,
}));

import { registerInstrumentationConsumers } from "./instrumentation-consumers";

const integrationCases: Array<
  [
    keyof InstrumentationIntegrationsConfig,
    Array<(typeof registrations)[keyof typeof registrations]>,
  ]
> = [
  ["aisdk", [registrations.aiSDK]],
  ["anthropic", [registrations.anthropic]],
  ["bedrock", [registrations.bedrockRuntime]],
  ["claudeAgentSDK", [registrations.claudeAgentSDK]],
  ["cloudflareAgents", [registrations.cloudflareAgents]],
  ["cloudflareAIChat", [registrations.cloudflareAIChat]],
  ["cloudflareThink", [registrations.cloudflareThink]],
  ["cohere", [registrations.cohere]],
  ["cursorSDK", [registrations.cursorSDK]],
  ["genkit", [registrations.genkit]],
  ["gitHubCopilot", [registrations.gitHubCopilot]],
  ["googleADK", [registrations.googleADK]],
  ["googleGenAI", [registrations.googleGenAI]],
  ["groq", [registrations.groq]],
  [
    "huggingface",
    [registrations.huggingFace, registrations.huggingFaceTransformers],
  ],
  ["langchain", [registrations.langChain]],
  ["langsmith", [registrations.langSmith]],
  ["mistral", [registrations.mistral]],
  ["ollama", [registrations.ollama]],
  ["openai", [registrations.openAI]],
  ["openAIAgents", [registrations.openAIAgents]],
  ["openaiCodexSDK", [registrations.openAICodex]],
  ["openrouter", [registrations.openRouter]],
  ["openrouterAgent", [registrations.openRouterAgent]],
  ["piCodingAgent", [registrations.piCodingAgent]],
  ["strandsAgentSDK", [registrations.strandsAgentSDK]],
  ["voyageai", [registrations.voyageAI]],
];

describe("registerInstrumentationConsumers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers every instrumentation consumer by default", () => {
    registerInstrumentationConsumers();

    for (const register of Object.values(registrations)) {
      expect(register).toHaveBeenCalledTimes(1);
    }
    expect(registrations.langSmith).toHaveBeenCalledWith({
      skipLangChainRuns: true,
    });
  });

  it.each(integrationCases)(
    "does not register the %s integration when disabled",
    (integration, disabledRegistrations) => {
      registerInstrumentationConsumers({
        integrations: { [integration]: false },
      });

      for (const register of disabledRegistrations) {
        expect(register).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["vercel", registrations.aiSDK],
    ["google", registrations.googleGenAI],
    ["cursor", registrations.cursorSDK],
    ["awsBedrock", registrations.bedrockRuntime],
    ["awsBedrockRuntime", registrations.bedrockRuntime],
    ["langgraph", registrations.langChain],
  ] as const)(
    "honors the legacy or related %s disable flag",
    (integration, register) => {
      registerInstrumentationConsumers({
        integrations: { [integration]: false },
      });

      expect(register).not.toHaveBeenCalled();
    },
  );

  it("tells LangSmith not to suppress LangChain runs when LangChain is disabled", () => {
    registerInstrumentationConsumers({ integrations: { langchain: false } });

    expect(registrations.langSmith).toHaveBeenCalledWith({
      skipLangChainRuns: false,
    });
  });
});
