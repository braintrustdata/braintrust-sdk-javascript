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
import { registerFlueInstrumentation } from "./providers/flue-instrumentation";
import { registerLangChainInstrumentation } from "./providers/langchain-instrumentation";
import { registerLangSmithInstrumentation } from "./providers/langsmith-instrumentation";
import { registerPiCodingAgentInstrumentation } from "./providers/pi-coding-agent-instrumentation";
import { registerStrandsAgentSDKInstrumentation } from "./providers/strands-agent-sdk-instrumentation";
import { registerVoyageAIInstrumentation } from "./providers/voyageai-instrumentation";
import { registerCloudflareAIChatInstrumentation } from "./providers/cloudflare-ai-chat-consumer";
import { registerCloudflareAgentsInstrumentation } from "./providers/cloudflare-agents-instrumentation";
import type { InstrumentationConfig } from "./config";

/**
 * Internal coordinator for all AI provider instrumentation consumers.
 *
 * This coordinator enables consumers for:
 * - OpenAI SDK (chat completions, embeddings, etc.)
 * - Anthropic SDK (messages)
 * - Claude Agent SDK (agent interactions)
 * - Vercel AI SDK (generateText, streamText, etc.)
 * - Google GenAI SDK
 * - HuggingFace Inference SDK
 * - LangChain.js and LangGraph
 * - Mistral SDK
 * - Ollama SDK
 * - Cohere SDK
 * - Voyage AI SDK
 *
 * The coordinator is automatically enabled when the Braintrust library is loaded.
 * Individual integrations can be disabled via configuration.
 */
export function registerInstrumentationConsumers(
  config: InstrumentationConfig = {},
): void {
  const integrations = config.integrations ?? {};

  // Enable OpenAI integration (default: true)
  if (integrations.openai !== false) {
    registerOpenAIInstrumentation();
  }

  if (integrations.openaiCodexSDK !== false) {
    registerOpenAICodexInstrumentation();
  }

  // Enable Anthropic integration (default: true)
  if (integrations.anthropic !== false) {
    registerAnthropicInstrumentation();
  }

  // Enable AI SDK integration (default: true)
  // Support both 'aisdk' and legacy 'vercel' config keys
  if (integrations.aisdk !== false && integrations.vercel !== false) {
    registerAISDKInstrumentation();
  }

  // Enable Claude Agent SDK integration (default: true)
  if (integrations.claudeAgentSDK !== false) {
    registerClaudeAgentSDKInstrumentation();
  }

  if (integrations.cloudflareThink !== false) {
    registerCloudflareThinkInstrumentation();
  }

  if (integrations.cursorSDK !== false && integrations.cursor !== false) {
    registerCursorSDKInstrumentation();
  }

  // Enable OpenAI Agents SDK integration (default: true)
  if (integrations.openAIAgents !== false) {
    registerOpenAIAgentsInstrumentation();
  }

  // Enable Google GenAI integration (default: true)
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

  // Enable Google ADK integration (default: true)
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

  if (integrations.flue !== false) {
    registerFlueInstrumentation();
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
