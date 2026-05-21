export interface InstrumentationIntegrationsConfig {
  openai?: boolean;
  anthropic?: boolean;
  vercel?: boolean;
  aisdk?: boolean;
  google?: boolean;
  googleGenAI?: boolean;
  googleADK?: boolean;
  huggingface?: boolean;
  claudeAgentSDK?: boolean;
  cursor?: boolean;
  cursorSDK?: boolean;
  flue?: boolean;
  mastra?: boolean;
  openAIAgents?: boolean;
  openrouter?: boolean;
  openrouterAgent?: boolean;
  mistral?: boolean;
  cohere?: boolean;
  groq?: boolean;
  genkit?: boolean;
  gitHubCopilot?: boolean;
  openaiCodexSDK?: boolean;
  langchain?: boolean;
  langgraph?: boolean;
}

export interface InstrumentationConfig {
  /**
   * Configuration for individual SDK integrations.
   * Set to false to disable instrumentation for that SDK.
   */
  integrations?: InstrumentationIntegrationsConfig;
}

const envIntegrationAliases: Record<
  string,
  keyof InstrumentationIntegrationsConfig
> = {
  openai: "openai",
  "openai-codex": "openaiCodexSDK",
  "openai-codex-sdk": "openaiCodexSDK",
  openaicodexsdk: "openaiCodexSDK",
  codex: "openaiCodexSDK",
  "codex-sdk": "openaiCodexSDK",
  anthropic: "anthropic",
  aisdk: "aisdk",
  "ai-sdk": "aisdk",
  "vercel-ai": "aisdk",
  vercel: "vercel",
  claudeagentsdk: "claudeAgentSDK",
  "claude-agent-sdk": "claudeAgentSDK",
  cursor: "cursor",
  "cursor-sdk": "cursorSDK",
  cursorsdk: "cursorSDK",
  flue: "flue",
  "flue-runtime": "flue",
  mastra: "mastra",
  "openai-agents": "openAIAgents",
  openaiagents: "openAIAgents",
  "openai-agents-core": "openAIAgents",
  openaiagentscore: "openAIAgents",
  google: "google",
  "google-genai": "googleGenAI",
  googlegenai: "googleGenAI",
  huggingface: "huggingface",
  openrouter: "openrouter",
  openrouteragent: "openrouterAgent",
  "openrouter-agent": "openrouterAgent",
  mistral: "mistral",
  googleadk: "googleADK",
  "google-adk": "googleADK",
  cohere: "cohere",
  groq: "groq",
  "groq-sdk": "groq",
  genkit: "genkit",
  "firebase-genkit": "genkit",
  githubcopilot: "gitHubCopilot",
  "github-copilot": "gitHubCopilot",
  "copilot-sdk": "gitHubCopilot",
  langchain: "langchain",
  "langchain-js": "langchain",
  "@langchain": "langchain",
  langgraph: "langgraph",
};

export function getDefaultInstrumentationIntegrations(): Record<
  keyof InstrumentationIntegrationsConfig,
  boolean
> {
  return {
    openai: true,
    openaiCodexSDK: true,
    anthropic: true,
    vercel: true,
    aisdk: true,
    google: true,
    googleGenAI: true,
    googleADK: true,
    huggingface: true,
    claudeAgentSDK: true,
    cursor: true,
    cursorSDK: true,
    flue: true,
    mastra: true,
    openAIAgents: true,
    openrouter: true,
    openrouterAgent: true,
    mistral: true,
    cohere: true,
    groq: true,
    genkit: true,
    gitHubCopilot: true,
    langchain: true,
    langgraph: true,
  };
}

export function readDisabledInstrumentationEnvConfig(
  disabledList: string | undefined,
): InstrumentationConfig {
  const integrations: Record<string, boolean> = {};

  if (disabledList) {
    for (const value of disabledList.split(",")) {
      const sdk = value.trim().toLowerCase();
      if (sdk.length > 0) {
        integrations[envIntegrationAliases[sdk] ?? sdk] = false;
      }
    }
  }

  return { integrations };
}

export function isInstrumentationIntegrationDisabled(
  integrations: InstrumentationIntegrationsConfig | undefined,
  ...names: (keyof InstrumentationIntegrationsConfig)[]
): boolean {
  return names.some((name) => integrations?.[name] === false);
}
