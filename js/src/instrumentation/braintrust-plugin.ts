import { BasePlugin } from "./core";
import { OpenAIPlugin } from "./plugins/openai-plugin";
import { AnthropicPlugin } from "./plugins/anthropic-plugin";
import { AISDKPlugin } from "./plugins/ai-sdk-plugin";
import { ClaudeAgentSDKPlugin } from "./plugins/claude-agent-sdk-plugin";
import { GoogleGenAIPlugin } from "./plugins/google-genai-plugin";
import { OpenRouterPlugin } from "./plugins/openrouter-plugin";

export interface BraintrustPluginConfig {
  integrations?: {
    openai?: boolean;
    anthropic?: boolean;
    vercel?: boolean;
    aisdk?: boolean;
    google?: boolean;
    googleGenAI?: boolean;
    claudeAgentSDK?: boolean;
    openrouter?: boolean;
  };
}

/**
 * Default Braintrust plugin that manages all AI provider instrumentation plugins.
 *
 * This plugin orchestrates:
 * - OpenAI SDK (chat completions, embeddings, etc.)
 * - Anthropic SDK (messages)
 * - Claude Agent SDK (agent interactions)
 * - Vercel AI SDK (generateText, streamText, etc.)
 * - Google GenAI SDK
 *
 * The plugin is automatically enabled when the Braintrust library is loaded.
 * Individual integrations can be disabled via configuration.
 */
export class BraintrustPlugin extends BasePlugin {
  private config: BraintrustPluginConfig;
  private openaiPlugin: OpenAIPlugin | null = null;
  private anthropicPlugin: AnthropicPlugin | null = null;
  private aiSDKPlugin: AISDKPlugin | null = null;
  private claudeAgentSDKPlugin: ClaudeAgentSDKPlugin | null = null;
  private googleGenAIPlugin: GoogleGenAIPlugin | null = null;
  private openRouterPlugin: OpenRouterPlugin | null = null;

  constructor(config: BraintrustPluginConfig = {}) {
    super();
    this.config = config;
  }

  protected onEnable(): void {
    const integrations = this.config.integrations || {};

    // Enable OpenAI integration (default: true)
    if (integrations.openai !== false) {
      this.openaiPlugin = new OpenAIPlugin();
      this.openaiPlugin.enable();
    }

    // Enable Anthropic integration (default: true)
    if (integrations.anthropic !== false) {
      this.anthropicPlugin = new AnthropicPlugin();
      this.anthropicPlugin.enable();
    }

    // Enable AI SDK integration (default: true)
    // Support both 'aisdk' and legacy 'vercel' config keys
    if (integrations.aisdk !== false && integrations.vercel !== false) {
      this.aiSDKPlugin = new AISDKPlugin();
      this.aiSDKPlugin.enable();
    }

    // Enable Claude Agent SDK integration (default: true)
    if (integrations.claudeAgentSDK !== false) {
      this.claudeAgentSDKPlugin = new ClaudeAgentSDKPlugin();
      this.claudeAgentSDKPlugin.enable();
    }

    // Enable Google GenAI integration (default: true)
    // Support both 'googleGenAI' and legacy 'google' config keys
    if (integrations.googleGenAI !== false && integrations.google !== false) {
      this.googleGenAIPlugin = new GoogleGenAIPlugin();
      this.googleGenAIPlugin.enable();
    }

    if (integrations.openrouter !== false) {
      this.openRouterPlugin = new OpenRouterPlugin();
      this.openRouterPlugin.enable();
    }
  }

  protected onDisable(): void {
    if (this.openaiPlugin) {
      this.openaiPlugin.disable();
      this.openaiPlugin = null;
    }

    if (this.anthropicPlugin) {
      this.anthropicPlugin.disable();
      this.anthropicPlugin = null;
    }

    if (this.aiSDKPlugin) {
      this.aiSDKPlugin.disable();
      this.aiSDKPlugin = null;
    }

    if (this.claudeAgentSDKPlugin) {
      this.claudeAgentSDKPlugin.disable();
      this.claudeAgentSDKPlugin = null;
    }

    if (this.googleGenAIPlugin) {
      this.googleGenAIPlugin.disable();
      this.googleGenAIPlugin = null;
    }

    if (this.openRouterPlugin) {
      this.openRouterPlugin.disable();
      this.openRouterPlugin = null;
    }
  }
}

// Re-export utility functions from OpenAIPlugin for backward compatibility
export {
  parseMetricsFromUsage,
  processImagesInOutput,
  aggregateChatCompletionChunks,
} from "./plugins/openai-plugin";
