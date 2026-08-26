import { registerOpenAIInstrumentation } from "./providers/openai-instrumentation";
import { registerOpenAICodexInstrumentation } from "./providers/openai-codex-instrumentation";
import { registerAnthropicInstrumentation } from "./providers/anthropic-instrumentation";
import { registerAISDKInstrumentation } from "./providers/ai-sdk-instrumentation";
import { registerClaudeAgentSDKInstrumentation } from "./providers/claude-agent-sdk-instrumentation";
import { registerCloudflareThinkInstrumentation } from "./providers/cloudflare-think-instrumentation";
import { registerCursorSDKInstrumentation } from "./providers/cursor-sdk-instrumentation";
import { registerOpenAIAgentsInstrumentation } from "./providers/openai-agents-instrumentation";
import { registerGoogleGenAIInstrumentation } from "./providers/google-genai-instrumentation";
import { registerHuggingFaceInstrumentation } from "./providers/huggingface-instrumentation";
import { registerHuggingFaceTransformersInstrumentation } from "./providers/huggingface-transformers-instrumentation";
import { registerOpenRouterAgentInstrumentation } from "./providers/openrouter-agent-instrumentation";
import { registerOpenRouterInstrumentation } from "./providers/openrouter-instrumentation";
import { registerMistralInstrumentation } from "./providers/mistral-instrumentation";
import { registerOllamaInstrumentation } from "./providers/ollama-instrumentation";
import { registerGoogleADKInstrumentation } from "./providers/google-adk-instrumentation";
import { registerCohereInstrumentation } from "./providers/cohere-instrumentation";
import { registerGroqInstrumentation } from "./providers/groq-instrumentation";
import { registerBedrockRuntimeInstrumentation } from "./providers/bedrock-runtime-instrumentation";
import { registerGenkitInstrumentation } from "./providers/genkit-instrumentation";
import { registerGitHubCopilotInstrumentation } from "./providers/github-copilot-instrumentation";
import { registerLangChainInstrumentation } from "./providers/langchain-instrumentation";
import { registerLangSmithInstrumentation } from "./providers/langsmith-instrumentation";
import { registerPiCodingAgentInstrumentation } from "./providers/pi-coding-agent-instrumentation";
import { registerStrandsAgentSDKInstrumentation } from "./providers/strands-agent-sdk-instrumentation";
import { registerVoyageAIInstrumentation } from "./providers/voyageai-instrumentation";
import { registerCloudflareAIChatInstrumentation } from "./providers/cloudflare-ai-chat-consumer";
import { registerCloudflareAgentsInstrumentation } from "./providers/cloudflare-agents-instrumentation";
import type { InstrumentationConfig } from "./config";

/** Registers the configured process-lifetime instrumentation consumers. */
export function registerInstrumentationConsumers(
  config: InstrumentationConfig = {},
): void {
  const integrations = config.integrations ?? {};

  if (integrations.openai !== false) {
    registerOpenAIInstrumentation();
  }

  if (integrations.openaiCodexSDK !== false) {
    registerOpenAICodexInstrumentation();
  }

  if (integrations.anthropic !== false) {
    registerAnthropicInstrumentation();
  }

  // Support both 'aisdk' and legacy 'vercel' config keys
  if (integrations.aisdk !== false && integrations.vercel !== false) {
    registerAISDKInstrumentation();
  }

  if (integrations.claudeAgentSDK !== false) {
    registerClaudeAgentSDKInstrumentation();
  }

  if (integrations.cloudflareThink !== false) {
    registerCloudflareThinkInstrumentation();
  }

  if (integrations.cursorSDK !== false && integrations.cursor !== false) {
    registerCursorSDKInstrumentation();
  }

  if (integrations.openAIAgents !== false) {
    registerOpenAIAgentsInstrumentation();
  }

  // Support both 'googleGenAI' and legacy 'google' config keys
  if (integrations.googleGenAI !== false && integrations.google !== false) {
    registerGoogleGenAIInstrumentation();
  }

  if (integrations.huggingface !== false) {
    registerHuggingFaceInstrumentation();
    registerHuggingFaceTransformersInstrumentation();
  }

  if (integrations.openrouter !== false) {
    registerOpenRouterInstrumentation();
  }

  if (integrations.openrouterAgent !== false) {
    registerOpenRouterAgentInstrumentation();
  }

  if (integrations.mistral !== false) {
    registerMistralInstrumentation();
  }

  if (integrations.ollama !== false) {
    registerOllamaInstrumentation();
  }

  if (integrations.googleADK !== false) {
    registerGoogleADKInstrumentation();
  }

  if (integrations.cohere !== false) {
    registerCohereInstrumentation();
  }

  if (integrations.voyageai !== false) {
    registerVoyageAIInstrumentation();
  }

  if (integrations.groq !== false) {
    registerGroqInstrumentation();
  }

  if (
    integrations.bedrock !== false &&
    integrations.awsBedrock !== false &&
    integrations.awsBedrockRuntime !== false
  ) {
    registerBedrockRuntimeInstrumentation();
  }

  if (integrations.genkit !== false) {
    registerGenkitInstrumentation();
  }

  if (integrations.gitHubCopilot !== false) {
    registerGitHubCopilotInstrumentation();
  }

  if (integrations.piCodingAgent !== false) {
    registerPiCodingAgentInstrumentation();
  }

  if (integrations.strandsAgentSDK !== false) {
    registerStrandsAgentSDKInstrumentation();
  }

  if (integrations.cloudflareAIChat !== false) {
    registerCloudflareAIChatInstrumentation();
  }

  if (integrations.cloudflareAgents !== false) {
    registerCloudflareAgentsInstrumentation();
  }

  if (integrations.langchain !== false && integrations.langgraph !== false) {
    registerLangChainInstrumentation();
  }

  if (integrations.langsmith !== false) {
    registerLangSmithInstrumentation({
      skipLangChainRuns: integrations.langchain !== false,
    });
  }

  // Mastra is intentionally not wired here: `@mastra/core` ships its own
  // ObservabilityExporter contract, and `BraintrustObservabilityExporter`
  // (wrappers/mastra.ts) is auto-installed by the loader patch in
  // `auto-instrumentations/loader/mastra-observability-patch.ts` rather than
  // by an instrumentation consumer / global hook subscription.
}
