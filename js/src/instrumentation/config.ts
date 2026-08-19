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
  cloudflareAIChat?: boolean;
  cloudflareThink?: boolean;
  cursor?: boolean;
  cursorSDK?: boolean;
  mastra?: boolean;
  openAIAgents?: boolean;
  openrouter?: boolean;
  openrouterAgent?: boolean;
  mistral?: boolean;
  ollama?: boolean;
  cohere?: boolean;
  groq?: boolean;
  bedrock?: boolean;
  awsBedrock?: boolean;
  awsBedrockRuntime?: boolean;
  genkit?: boolean;
  gitHubCopilot?: boolean;
  openaiCodexSDK?: boolean;
  piCodingAgent?: boolean;
  strandsAgentSDK?: boolean;
  cloudflareAgents?: boolean;
  langchain?: boolean;
  langgraph?: boolean;
  langsmith?: boolean;
  voyageai?: boolean;
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
  "pi-coding-agent": "piCodingAgent",
  "pi-coding-agent-sdk": "piCodingAgent",
  picodingagent: "piCodingAgent",
  picodingagentsdk: "piCodingAgent",
  "@earendil-works/pi-coding-agent": "piCodingAgent",
  strandsAgentSDK: "strandsAgentSDK",
  strandsagentsdk: "strandsAgentSDK",
  "strands-agent-sdk": "strandsAgentSDK",
  "@strands-agents/sdk": "strandsAgentSDK",
  agents: "cloudflareAgents",
  "cloudflare-agents": "cloudflareAgents",
  cloudflareagents: "cloudflareAgents",
  anthropic: "anthropic",
  aisdk: "aisdk",
  "ai-sdk": "aisdk",
  "vercel-ai": "aisdk",
  vercel: "vercel",
  claudeagentsdk: "claudeAgentSDK",
  "claude-agent-sdk": "claudeAgentSDK",
  cloudflareaichat: "cloudflareAIChat",
  "cloudflare-ai-chat": "cloudflareAIChat",
  "@cloudflare/ai-chat": "cloudflareAIChat",
  cloudflarethink: "cloudflareThink",
  cursor: "cursor",
  "cursor-sdk": "cursorSDK",
  cursorsdk: "cursorSDK",
  mastra: "mastra",
  "openai-agents": "openAIAgents",
  openaiagents: "openAIAgents",
  "openai-agents-core": "openAIAgents",
  openaiagentscore: "openAIAgents",
  google: "google",
  "google-genai": "googleGenAI",
  googlegenai: "googleGenAI",
  huggingface: "huggingface",
  "@huggingface/transformers": "huggingface",
  transformers: "huggingface",
  openrouter: "openrouter",
  openrouteragent: "openrouterAgent",
  "openrouter-agent": "openrouterAgent",
  mistral: "mistral",
  ollama: "ollama",
  googleadk: "googleADK",
  "google-adk": "googleADK",
  cohere: "cohere",
  groq: "groq",
  "groq-sdk": "groq",
  bedrock: "bedrock",
  "aws-bedrock": "awsBedrock",
  awsbedrock: "awsBedrock",
  "aws-bedrock-runtime": "awsBedrockRuntime",
  awsbedrockruntime: "awsBedrockRuntime",
  "@aws-sdk/client-bedrock-runtime": "awsBedrockRuntime",
  genkit: "genkit",
  "firebase-genkit": "genkit",
  githubcopilot: "gitHubCopilot",
  "github-copilot": "gitHubCopilot",
  "copilot-sdk": "gitHubCopilot",
  langchain: "langchain",
  "langchain-js": "langchain",
  "@langchain": "langchain",
  langgraph: "langgraph",
  langsmith: "langsmith",
  voyage: "voyageai",
  "voyage-ai": "voyageai",
  voyageai: "voyageai",
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
    cloudflareAIChat: true,
    cloudflareThink: true,
    cursor: true,
    cursorSDK: true,
    mastra: true,
    openAIAgents: true,
    openrouter: true,
    openrouterAgent: true,
    mistral: true,
    ollama: true,
    cohere: true,
    groq: true,
    bedrock: true,
    awsBedrock: true,
    awsBedrockRuntime: true,
    genkit: true,
    gitHubCopilot: true,
    langchain: true,
    langgraph: true,
    langsmith: true,
    voyageai: true,
    piCodingAgent: true,
    strandsAgentSDK: true,
    cloudflareAgents: true,
  };
}

export function readDisabledInstrumentationEnvConfig(
  disabledList: string | undefined,
): InstrumentationConfig {
  const integrations: Record<string, boolean> = {};

  if (disabledList) {
    for (const value of disabledList.split(",")) {
      const rawSdk = value.trim();
      const sdk = rawSdk.toLowerCase();
      if (sdk.length > 0) {
        integrations[
          envIntegrationAliases[rawSdk] ?? envIntegrationAliases[sdk] ?? sdk
        ] = false;
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
