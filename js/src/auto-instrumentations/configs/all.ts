import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import {
  isInstrumentationIntegrationDisabled,
  readDisabledInstrumentationEnvConfig,
  type InstrumentationIntegrationsConfig,
} from "../../instrumentation/config";
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
import { langchainConfigs } from "./langchain";
import { mistralConfigs } from "./mistral";
import { openAIAgentsCoreConfigs } from "./openai-agents";
import { openaiConfigs } from "./openai";
import { openAICodexConfigs } from "./openai-codex";
import { openRouterConfigs } from "./openrouter";
import { openRouterAgentConfigs } from "./openrouter-agent";

interface InstrumentationConfigGroup {
  integrations: readonly (keyof InstrumentationIntegrationsConfig)[];
  configs: readonly InstrumentationConfig[];
}

const defaultInstrumentationConfigGroups: readonly InstrumentationConfigGroup[] =
  [
    { integrations: ["openai"], configs: openaiConfigs },
    {
      integrations: ["openaiCodexSDK"],
      configs: openAICodexConfigs,
    },
    { integrations: ["anthropic"], configs: anthropicConfigs },
    {
      integrations: ["aisdk", "vercel"],
      configs: aiSDKConfigs,
    },
    {
      integrations: ["claudeAgentSDK"],
      configs: claudeAgentSDKConfigs,
    },
    { integrations: ["cursor", "cursorSDK"], configs: cursorSDKConfigs },
    { integrations: ["flue"], configs: flueConfigs },
    {
      integrations: ["openAIAgents"],
      configs: openAIAgentsCoreConfigs,
    },
    {
      integrations: ["google", "googleGenAI"],
      configs: googleGenAIConfigs,
    },
    { integrations: ["huggingface"], configs: huggingFaceConfigs },
    {
      integrations: ["langchain", "langgraph"],
      configs: langchainConfigs,
    },
    { integrations: ["openrouter"], configs: openRouterConfigs },
    {
      integrations: ["openrouterAgent"],
      configs: openRouterAgentConfigs,
    },
    { integrations: ["mistral"], configs: mistralConfigs },
    { integrations: ["googleADK"], configs: googleADKConfigs },
    { integrations: ["cohere"], configs: cohereConfigs },
    { integrations: ["groq"], configs: groqConfigs },
    {
      integrations: ["genkit"],
      configs: genkitConfigs,
    },
    {
      integrations: ["gitHubCopilot"],
      configs: gitHubCopilotConfigs,
    },
    // Note: `@mastra/core` is not listed here because its instrumentation
    // doesn't go through the AST `code-transformer` matcher — Mastra's
    // content-hashed chunks make `filePath`-based matching too brittle.
    // Instead it's handled by the source-replacement entry in
    // `loader/special-case-patches.ts`, which both the runtime loader
    // (`hook.mjs` → `cjs-patch.ts`/`esm-hook.mts`) and the bundler plugin
    // (`bundler/plugin.ts`) call. The `mastra` env-var disable still works.
  ];

export function getDefaultInstrumentationConfigs({
  additionalInstrumentations,
  disabledIntegrationConfig,
  disabledIntegrations,
}: {
  additionalInstrumentations?: readonly InstrumentationConfig[];
  disabledIntegrationConfig?: InstrumentationIntegrationsConfig;
  disabledIntegrations?: ReadonlySet<string>;
} = {}): InstrumentationConfig[] {
  const disabledConfig =
    disabledIntegrationConfig ??
    (disabledIntegrations
      ? readDisabledInstrumentationEnvConfig(
          [...disabledIntegrations].join(","),
        ).integrations
      : undefined);

  return [
    ...defaultInstrumentationConfigGroups.flatMap(
      ({ configs, integrations }) =>
        isInstrumentationIntegrationDisabled(disabledConfig, ...integrations)
          ? []
          : configs,
    ),
    ...(additionalInstrumentations ?? []),
  ];
}

export function getDefaultAutoInstrumentationConfigs(): InstrumentationConfig[] {
  return getDefaultInstrumentationConfigs({
    disabledIntegrationConfig: readDisabledInstrumentationEnvConfig(
      process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
    ).integrations,
  });
}
