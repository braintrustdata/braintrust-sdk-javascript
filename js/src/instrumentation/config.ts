export type SpanExportData = Record<string, unknown>;

export interface SpanCustomizer {
  /**
   * Customize outgoing native SDK records and Braintrust OpenTelemetry snapshots,
   * including manual, instrumented, logger, and experiment spans, before transport
   * serialization. Native records are incremental; OTel snapshots contain
   * attributes, events, links, resource, instrumentationScope and spanContext.
   * Dataset rows and feedback records are not customized.
   *
   * Callbacks are synchronous. Add, change, or delete payload fields, then return
   * the record or a replacement plain object. Payloads may still contain SDK
   * Attachment objects; attachment processing and serialization happen later.
   * Throwing or returning an invalid value (including a promise) stops the chain
   * and exports only original identity, routing, and duration timestamps, plus
   * context: { customizer_error: true } (OTel: braintrust.context_json string
   * attribute). No attachments from that record upload. A safe error is logged
   * at most once per JavaScript global environment across both pipelines.
   * Later records are evaluated independently; already exported records cannot
   * be retracted. Handle recovery inside the callback to retain span content.
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
  typesafe?: boolean;
  workersAI?: boolean;
  elevenlabs?: boolean;
  /** Set to false to disable, or pass options; options keep LiveKit enabled. */
  livekit?: boolean | LiveKitIntegrationConfig;
}

export interface LiveKitIntegrationConfig {
  /**
   * How recorded call audio is encoded. Recording itself still requires
   * BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS or
   * BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS.
   *
   * Defaults to Opus in Ogg when `@braintrust/audio` is installed, and raw
   * PCM otherwise. Set `codec: { name: "pcm" }`, or
   * BRAINTRUST_AUDIO_COMPRESSION=false, to always record raw PCM.
   *
   * @example
   * ```ts
   * configureInstrumentation({
   *   integrations: {
   *     livekit: {
   *       audio: { codec: { name: "opus", options: { bitrate: 32_000 } } },
   *     },
   *   },
   * });
   * ```
   */
  audio?: AudioEncodingConfig;
}

export interface AudioEncodingConfig {
  codec?:
    | { name: "pcm" }
    | {
        name: "opus";
        options?: {
          /** Target bitrate in bits per second, from 6000 to 510000. Defaults to 64000. */
          bitrate?: number;
          /** Encoder effort from 0 (fastest) to 10. Defaults to 5. */
          complexity?: number;
          /** Encoder tuning. Defaults to `"audio"`; `"voip"` favors speech. */
          application?: "audio" | "voip" | "lowdelay";
        };
      };
  /** The file format for encoded audio. Defaults to `ogg` for Opus. */
  container?: { name: "ogg" };
}

export const DEFAULT_STREAMING_ATTACHMENT_BUFFER_BYTES = 4 * 1024 * 1024;

export interface InstrumentationConfig {
  /**
   * Target attachment payload size in bytes for each segmentable media stream.
   * Defaults to 4 MiB. Must be a positive safe integer.
   * Instrumentations flush at valid media boundaries and on recording completion.
   * Counts binary bytes after decoding and format conversion, excluding metadata.
   * Audio recordings count raw PCM before compression, so compressed uploads
   * are smaller than this size.
   * Whole-file responses remain intact and may exceed this threshold.
   * This is not a total memory limit and does not enable attachment capture.
   * Configure before initializing the SDK or enabling instrumentation.
   */
  streamingAttachmentBufferBytes?: number;

  /**
   * Configuration for individual SDK integrations.
   * Set to false to disable instrumentation for that SDK.
   */
  integrations?: InstrumentationIntegrationsConfig;

  /**
   * Customizers for all native SDK and Braintrust OpenTelemetry spans, in order.
   * Native hooks receive span records; OTel hooks receive plain snapshots with
   * attributes, events, links, resource, instrumentationScope and spanContext.
   * Configure before initializing the SDK or enabling instrumentation.
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
  workersai: "workersAI",
  "workers-ai": "workersAI",
  typesafe: "typesafe",
  "typesafe-ai": "typesafe",
  "@typesafe-ai/sdk": "typesafe",
  elevenlabs: "elevenlabs",
  "@elevenlabs/elevenlabs-js": "elevenlabs",
  livekit: "livekit",
  "@livekit/agents": "livekit",
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
    typesafe: true,
    workersAI: true,
    elevenlabs: true,
    livekit: true,
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
