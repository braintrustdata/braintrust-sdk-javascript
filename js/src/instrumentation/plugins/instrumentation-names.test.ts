import { describe, expect, it } from "vitest";

import { INSTRUMENTATION_NAMES } from "../../span-origin";
import { aiSDKChannels, harnessAgentChannels } from "./ai-sdk-channels";
import { anthropicChannels } from "./anthropic-channels";
import {
  bedrockRuntimeChannels,
  smithyClientChannels,
  smithyCoreChannels,
} from "./bedrock-runtime-channels";
import { claudeAgentSDKChannels } from "./claude-agent-sdk-channels";
import { cohereChannels } from "./cohere-channels";
import { cursorSDKChannels } from "./cursor-sdk-channels";
import { flueChannels } from "./flue-channels";
import { genkitChannels, genkitCoreChannels } from "./genkit-channels";
import { gitHubCopilotChannels } from "./github-copilot-channels";
import { googleADKChannels } from "./google-adk-channels";
import { googleGenAIChannels } from "./google-genai-channels";
import { groqChannels } from "./groq-channels";
import { huggingFaceChannels } from "./huggingface-channels";
import { langChainChannels } from "./langchain-channels";
import { langSmithChannels } from "./langsmith-channels";
import { mistralChannels } from "./mistral-channels";
import { openAIAgentsCoreChannels } from "./openai-agents-channels";
import { openAIChannels } from "./openai-channels";
import { openAICodexChannels } from "./openai-codex-channels";
import { openRouterAgentChannels } from "./openrouter-agent-channels";
import { openRouterChannels } from "./openrouter-channels";
import { piCodingAgentChannels } from "./pi-coding-agent-channels";
import { strandsAgentSDKChannels } from "./strands-agent-sdk-channels";

describe("built-in instrumentation provenance names", () => {
  it.each([
    [aiSDKChannels.generateText, INSTRUMENTATION_NAMES.AI_SDK],
    [harnessAgentChannels.generate, INSTRUMENTATION_NAMES.AI_SDK],
    [anthropicChannels.messagesCreate, INSTRUMENTATION_NAMES.ANTHROPIC],
    [bedrockRuntimeChannels.clientSend, INSTRUMENTATION_NAMES.BEDROCK_RUNTIME],
    [smithyCoreChannels.clientSend, INSTRUMENTATION_NAMES.BEDROCK_RUNTIME],
    [smithyClientChannels.clientSend, INSTRUMENTATION_NAMES.BEDROCK_RUNTIME],
    [claudeAgentSDKChannels.query, INSTRUMENTATION_NAMES.CLAUDE_AGENT_SDK],
    [cohereChannels.chat, INSTRUMENTATION_NAMES.COHERE],
    [cursorSDKChannels.create, INSTRUMENTATION_NAMES.CURSOR_SDK],
    [flueChannels.createContext, INSTRUMENTATION_NAMES.FLUE],
    [genkitChannels.generate, INSTRUMENTATION_NAMES.GENKIT],
    [genkitCoreChannels.actionSpan, INSTRUMENTATION_NAMES.GENKIT],
    [gitHubCopilotChannels.createSession, INSTRUMENTATION_NAMES.GITHUB_COPILOT],
    [googleADKChannels.runnerRunAsync, INSTRUMENTATION_NAMES.GOOGLE_ADK],
    [googleGenAIChannels.generateContent, INSTRUMENTATION_NAMES.GOOGLE_GENAI],
    [groqChannels.chatCompletionsCreate, INSTRUMENTATION_NAMES.GROQ],
    [huggingFaceChannels.chatCompletion, INSTRUMENTATION_NAMES.HUGGINGFACE],
    [langChainChannels.configure, INSTRUMENTATION_NAMES.LANGCHAIN],
    [langSmithChannels.createRun, INSTRUMENTATION_NAMES.LANGSMITH],
    [mistralChannels.chatComplete, INSTRUMENTATION_NAMES.MISTRAL],
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
  ])("uses %s for its canonical channel group", (channel, expected) => {
    expect(channel.instrumentationName).toBe(expected);
  });
});
