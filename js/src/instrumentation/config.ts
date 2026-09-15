import type { Span } from "../logger";

/**
 * Borrowed provider objects used by an instrumentation to create a span.
 *
 * Do not mutate or retain this context or its values after the callback returns.
 * Copy any data that needs to outlive the callback.
 */
export interface InstrumentationContext {
  /** Stable instrumentation name, such as "openai" or "anthropic". */
  readonly name: string;

  /**
   * Get an instrumentation-specific object, or undefined when unavailable.
   * Key names and value types are defined by each instrumentation.
   */
  get(key: string): unknown;
}

/**
 * One span's outgoing record, with lazy values resolved, before JSON
 * serialization. This is an incremental update, not necessarily a complete
 * span; a span can produce multiple records, including before it ends.
 *
 * All fields are available for inspection and mutation. Returned data must
 * remain JSON-serializable. Identity and routing fields, including id,
 * span_id, root_span_id, and span_parents, must not be changed or removed.
 */
export type SpanExportData = Record<string, unknown>;

/**
 * Customize spans created by Braintrust instrumentation.
 *
 * Callbacks are synchronous and run in registration order. Exceptions are
 * swallowed and processing continues without changing provider results or
 * preventing span finalization.
 *
 * @remarks API declaration only; customizer execution is not implemented yet.
 */
export interface SpanCustomizer {
  /**
   * Called after final output, metrics, or error capture, immediately before
   * the instrumented span ends. For streams, this is at termination, not when
   * the provider returns an iterator.
   *
   * Use span.log() or span.setAttributes() to customize the span; do not end it.
   * Earlier updates may already be uploaded, so this is not a redaction hook.
   */
  onSpanEnding?(span: Span, ctx: InstrumentationContext): void;

  /**
   * Inspect and transform a span's outgoing record before JSON serialization
   * and upload. This can be used to redact sensitive data.
   *
   * Mutate the data in place and return it, or return a replacement record.
   * Each customizer receives the previous customizer's returned record.
   * A record must be returned; dropping records is not supported.
   *
   * Preserve identity and routing fields and return JSON-serializable data.
   * Called once per outgoing record, not per transport retry. No provider
   * context is retained for this callback.
   */
  onSpanExport?(data: SpanExportData): SpanExportData;
}

export interface InstrumentationIntegrationsConfig {
  openai?: boolean;
  anthropic?: boolean;
  vercel?: boolean;
  aisdk?: boolean;
  google?: boolean;
  googleGenAI?: boolean;
  googleGenerativeAI?: boolean;
  googleADK?: boolean;
  huggingface?: boolean;
  claudeAgentSDK?: boolean;
  cloudflareAIChat?: boolean;
  cloudflareThink?: boolean;
  cursor?: boolean;
  cursorSDK?: boolean;
  flue?: boolean;
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
  langgraphSDK?: boolean;
  langsmith?: boolean;
  voyageai?: boolean;
  elevenlabs?: boolean;
}

export interface InstrumentationConfig {
  /**
   * Configuration for individual SDK integrations.
   * Set to false to disable instrumentation for that SDK.
   */
  integrations?: InstrumentationIntegrationsConfig;

  /**
   * Instrumentation-wide customizers, in callback execution order.
   * Configure before instrumentation is enabled.
   *
   * @remarks API declaration only; these callbacks are not invoked yet.
   */
  spanCustomizers?: readonly SpanCustomizer[];
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
  flue: "flue",
  "flue-runtime": "flue",
  mastra: "mastra",
  "openai-agents": "openAIAgents",
  openaiagents: "openAIAgents",
  "openai-agents-core": "openAIAgents",
  openaiagentscore: "openAIAgents",
  google: "google",
  "google-generative-ai": "googleGenerativeAI",
  googlegenerativeai: "googleGenerativeAI",
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
  langgraphsdk: "langgraphSDK",
  "langgraph-sdk": "langgraphSDK",
  "@langchain/langgraph-sdk": "langgraphSDK",
  langsmith: "langsmith",
  voyage: "voyageai",
  "voyage-ai": "voyageai",
  voyageai: "voyageai",
  elevenlabs: "elevenlabs",
  "@elevenlabs/elevenlabs-js": "elevenlabs",
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
    googleGenerativeAI: true,
    googleADK: true,
    huggingface: true,
    claudeAgentSDK: true,
    cloudflareAIChat: true,
    cloudflareThink: true,
    cursor: true,
    cursorSDK: true,
    flue: true,
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
    langgraphSDK: true,
    langsmith: true,
    voyageai: true,
    elevenlabs: true,
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
