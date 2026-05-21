import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { aiSDKConfigs } from "./ai-sdk";
import { anthropicConfigs } from "./anthropic";
import { claudeAgentSDKConfigs } from "./claude-agent-sdk";
import { cohereConfigs } from "./cohere";
import { cursorSDKConfigs } from "./cursor-sdk";
import { flueConfigs } from "./flue";
import { genkitConfigs } from "./genkit";
import { gitHubCopilotConfigs } from "./github-copilot";
import { googleADKConfigs } from "./google-adk";
import { googleGenAIConfigs } from "./google-genai";
import { groqConfigs } from "./groq";
import { huggingFaceConfigs } from "./huggingface";
import { mistralConfigs } from "./mistral";
import { openaiConfigs } from "./openai";
import { openAICodexConfigs } from "./openai-codex";
import { openRouterConfigs } from "./openrouter";
import { openRouterAgentConfigs } from "./openrouter-agent";

interface InstrumentationConfigGroup {
  disabledNames: readonly string[];
  configs: readonly InstrumentationConfig[];
}

const defaultInstrumentationConfigGroups: readonly InstrumentationConfigGroup[] =
  [
    { disabledNames: ["openai"], configs: openaiConfigs },
    {
      disabledNames: ["openai-codex", "openai-codex-sdk", "codex", "codex-sdk"],
      configs: openAICodexConfigs,
    },
    { disabledNames: ["anthropic"], configs: anthropicConfigs },
    {
      disabledNames: ["aisdk", "ai-sdk", "vercel-ai"],
      configs: aiSDKConfigs,
    },
    {
      disabledNames: ["claudeagentsdk", "claude-agent-sdk"],
      configs: claudeAgentSDKConfigs,
    },
    { disabledNames: ["cursor", "cursor-sdk"], configs: cursorSDKConfigs },
    { disabledNames: ["flue", "flue-runtime"], configs: flueConfigs },
    {
      disabledNames: ["google", "google-genai"],
      configs: googleGenAIConfigs,
    },
    { disabledNames: ["huggingface"], configs: huggingFaceConfigs },
    { disabledNames: ["openrouter"], configs: openRouterConfigs },
    {
      disabledNames: ["openrouteragent", "openrouter-agent"],
      configs: openRouterAgentConfigs,
    },
    { disabledNames: ["mistral"], configs: mistralConfigs },
    { disabledNames: ["googleadk", "google-adk"], configs: googleADKConfigs },
    { disabledNames: ["cohere"], configs: cohereConfigs },
    { disabledNames: ["groq", "groq-sdk"], configs: groqConfigs },
    {
      disabledNames: ["genkit", "firebase-genkit"],
      configs: genkitConfigs,
    },
    {
      disabledNames: ["githubcopilot", "github-copilot", "copilot-sdk"],
      configs: gitHubCopilotConfigs,
    },
  ];

export function getDefaultInstrumentationConfigs({
  additionalInstrumentations,
  disabledIntegrations,
}: {
  additionalInstrumentations?: readonly InstrumentationConfig[];
  disabledIntegrations?: ReadonlySet<string>;
} = {}): InstrumentationConfig[] {
  return [
    ...defaultInstrumentationConfigGroups.flatMap(
      ({ configs, disabledNames }) =>
        disabledIntegrations &&
        disabledNames.some((name) => disabledIntegrations.has(name))
          ? []
          : configs,
    ),
    ...(additionalInstrumentations ?? []),
  ];
}
