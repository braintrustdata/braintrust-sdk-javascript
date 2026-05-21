import type { InstrumentationConfig as CodeTransformerInstrumentationConfig } from "@apm-js-collab/code-transformer";
import {
  isInstrumentationIntegrationDisabled,
  readDisabledInstrumentationEnvConfig,
  type InstrumentationIntegrationsConfig,
} from "../instrumentation/config";
import { openaiConfigs } from "./configs/openai";
import { openAICodexConfigs } from "./configs/openai-codex";
import { anthropicConfigs } from "./configs/anthropic";
import { aiSDKConfigs } from "./configs/ai-sdk";
import { claudeAgentSDKConfigs } from "./configs/claude-agent-sdk";
import { cursorSDKConfigs } from "./configs/cursor-sdk";
import { googleGenAIConfigs } from "./configs/google-genai";
import { huggingFaceConfigs } from "./configs/huggingface";
import { openRouterAgentConfigs } from "./configs/openrouter-agent";
import { openRouterConfigs } from "./configs/openrouter";
import { mistralConfigs } from "./configs/mistral";
import { googleADKConfigs } from "./configs/google-adk";
import { cohereConfigs } from "./configs/cohere";
import { groqConfigs } from "./configs/groq";
import { genkitConfigs } from "./configs/genkit";
import { gitHubCopilotConfigs } from "./configs/github-copilot";

type AutoInstrumentationConfigGroup = {
  integrations: (keyof InstrumentationIntegrationsConfig)[];
  configs: CodeTransformerInstrumentationConfig[];
};

const autoInstrumentationConfigGroups: AutoInstrumentationConfigGroup[] = [
  { integrations: ["openai"], configs: openaiConfigs },
  { integrations: ["openaiCodexSDK"], configs: openAICodexConfigs },
  { integrations: ["anthropic"], configs: anthropicConfigs },
  { integrations: ["aisdk", "vercel"], configs: aiSDKConfigs },
  { integrations: ["claudeAgentSDK"], configs: claudeAgentSDKConfigs },
  { integrations: ["cursor", "cursorSDK"], configs: cursorSDKConfigs },
  { integrations: ["google", "googleGenAI"], configs: googleGenAIConfigs },
  { integrations: ["huggingface"], configs: huggingFaceConfigs },
  { integrations: ["openrouter"], configs: openRouterConfigs },
  { integrations: ["openrouterAgent"], configs: openRouterAgentConfigs },
  { integrations: ["mistral"], configs: mistralConfigs },
  { integrations: ["googleADK"], configs: googleADKConfigs },
  { integrations: ["cohere"], configs: cohereConfigs },
  { integrations: ["groq"], configs: groqConfigs },
  { integrations: ["genkit"], configs: genkitConfigs },
  { integrations: ["gitHubCopilot"], configs: gitHubCopilotConfigs },
];

export function getDefaultAutoInstrumentationConfigs(): CodeTransformerInstrumentationConfig[] {
  const integrations = readDisabledInstrumentationEnvConfig(
    process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
  ).integrations;

  return autoInstrumentationConfigGroups.flatMap(
    ({ integrations: keys, configs }) =>
      isInstrumentationIntegrationDisabled(integrations, ...keys)
        ? []
        : configs,
  );
}
