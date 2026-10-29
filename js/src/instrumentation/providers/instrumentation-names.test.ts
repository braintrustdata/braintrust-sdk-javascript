import { describe, expect, it } from "vite-plus/test";

import { INSTRUMENTATION_NAMES } from "../../span-origin";
import { aiSDKChannels, harnessAgentChannels } from "./ai-sdk-interceptors";
import { anthropicChannels } from "./anthropic-interceptors";
import {
  bedrockRuntimeChannels,
  smithyClientChannels,
  smithyCoreChannels,
} from "./bedrock-runtime-interceptors";
import { claudeAgentSDKChannels } from "./claude-agent-sdk-interceptors";
import { cloudflareAgentsChannels } from "./cloudflare-agents-interceptors";
import { cloudflareAIChatChannels } from "./cloudflare-ai-chat-interceptors";
import { cloudflareThinkChannels } from "./cloudflare-think-interceptors";
import { cohereChannels } from "./cohere-interceptors";
import { cursorSDKChannels } from "./cursor-sdk-interceptors";
import { genkitChannels, genkitCoreChannels } from "./genkit-interceptors";
import { gitHubCopilotChannels } from "./github-copilot-interceptors";
import { googleADKChannels } from "./google-adk-interceptors";
import { googleGenAIChannels } from "./google-genai-interceptors";
import { googleGenerativeAIChannels } from "./google-generative-ai-interceptors";
import { groqChannels } from "./groq-interceptors";
import { huggingFaceChannels } from "./huggingface-interceptors";
import { langChainChannels } from "./langchain-interceptors";
import { langGraphSDKChannels } from "./langgraph-sdk-interceptors";
import { langSmithChannels } from "./langsmith-interceptors";
import {
  mcpChannels,
  mcpSDKChannels,
  mcpServerChannels,
} from "./mcp-interceptors";
import { mistralChannels } from "./mistral-interceptors";
import { ollamaChannels } from "./ollama-interceptors";
import { openAIAgentsCoreChannels } from "./openai-agents-interceptors";
import { openAIChannels } from "./openai-interceptors";
import { openAICodexChannels } from "./openai-codex-interceptors";
import { openRouterAgentChannels } from "./openrouter-agent-interceptors";
import { openRouterChannels } from "./openrouter-interceptors";
import { piCodingAgentChannels } from "./pi-coding-agent-interceptors";
import { strandsAgentSDKChannels } from "./strands-agent-sdk-interceptors";

describe("wrapping definitions are independent of span provenance", () => {
  it.each([
    [aiSDKChannels.generateText, INSTRUMENTATION_NAMES.AI_SDK],
    [harnessAgentChannels.generate, INSTRUMENTATION_NAMES.AI_SDK],
    [anthropicChannels.messagesCreate, INSTRUMENTATION_NAMES.ANTHROPIC],
    [bedrockRuntimeChannels.clientSend, INSTRUMENTATION_NAMES.BEDROCK_RUNTIME],
    [smithyCoreChannels.clientSend, INSTRUMENTATION_NAMES.BEDROCK_RUNTIME],
    [smithyClientChannels.clientSend, INSTRUMENTATION_NAMES.BEDROCK_RUNTIME],
    [claudeAgentSDKChannels.query, INSTRUMENTATION_NAMES.CLAUDE_AGENT_SDK],
    [
      cloudflareAIChatChannels.runExclusiveChatTurn,
      INSTRUMENTATION_NAMES.CLOUDFLARE_AI_CHAT,
    ],
    [
      cloudflareAgentsChannels.runAgentTool,
      INSTRUMENTATION_NAMES.CLOUDFLARE_AGENTS,
    ],
    [
      cloudflareThinkChannels.runInferenceLoop,
      INSTRUMENTATION_NAMES.CLOUDFLARE_THINK,
    ],
    [cohereChannels.chat, INSTRUMENTATION_NAMES.COHERE],
    [cursorSDKChannels.create, INSTRUMENTATION_NAMES.CURSOR_SDK],
    [genkitChannels.generate, INSTRUMENTATION_NAMES.GENKIT],
    [genkitCoreChannels.actionSpan, INSTRUMENTATION_NAMES.GENKIT],
    [gitHubCopilotChannels.createSession, INSTRUMENTATION_NAMES.GITHUB_COPILOT],
    [googleADKChannels.runnerRunAsync, INSTRUMENTATION_NAMES.GOOGLE_ADK],
    [
      googleGenerativeAIChannels.generateContent,
      INSTRUMENTATION_NAMES.GOOGLE_GENERATIVE_AI,
    ],
    [googleGenAIChannels.generateContent, INSTRUMENTATION_NAMES.GOOGLE_GENAI],
    [groqChannels.chatCompletionsCreate, INSTRUMENTATION_NAMES.GROQ],
    [huggingFaceChannels.chatCompletion, INSTRUMENTATION_NAMES.HUGGINGFACE],
    [langGraphSDKChannels.wait, INSTRUMENTATION_NAMES.LANGGRAPH_SDK],
    [langChainChannels.configure, INSTRUMENTATION_NAMES.LANGCHAIN],
    [langSmithChannels.createRun, INSTRUMENTATION_NAMES.LANGSMITH],
    [mcpChannels.requestHandler, INSTRUMENTATION_NAMES.MCP],
    [mcpSDKChannels.setRequestHandler, INSTRUMENTATION_NAMES.MCP],
    [mcpServerChannels.setRequestHandler, INSTRUMENTATION_NAMES.MCP],
    [mistralChannels.chatComplete, INSTRUMENTATION_NAMES.MISTRAL],
    [ollamaChannels.chat, INSTRUMENTATION_NAMES.OLLAMA],
    [
      openAIAgentsCoreChannels.onTraceStart,
      INSTRUMENTATION_NAMES.OPENAI_AGENTS,
    ],
    [openAIChannels.chatCompletionsCreate, INSTRUMENTATION_NAMES.OPENAI],
    [openAICodexChannels.run, INSTRUMENTATION_NAMES.OPENAI_CODEX],
    [openRouterAgentChannels.callModel, INSTRUMENTATION_NAMES.OPENROUTER_AGENT],
    [openRouterChannels.chatSend, INSTRUMENTATION_NAMES.OPENROUTER],
    [piCodingAgentChannels.prompt, INSTRUMENTATION_NAMES.PI_CODING_AGENT],
    [
      strandsAgentSDKChannels.agentStream,
      INSTRUMENTATION_NAMES.STRANDS_AGENT_SDK,
    ],
  ])("keeps span configuration out of %s", (channel, _instrumentationName) => {
    expect(channel).not.toHaveProperty("instrumentationName");
    expect(channel).not.toHaveProperty("tracingChannel");
  });
});
