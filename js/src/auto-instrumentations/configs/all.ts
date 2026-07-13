import type { InstrumentationConfig } from "../orchestrion-js";
import {
  filterModuleExportPatchConfigs,
  type ModuleExportPatchConfig,
  type ModuleExportPatchTarget,
} from "../loader/module-hooks/registry";
import {
  isInstrumentationIntegrationDisabled,
  readDisabledInstrumentationEnvConfig,
  type InstrumentationIntegrationsConfig,
} from "../../instrumentation/config";
import { aiSDKOrchestrionConfigs } from "./ai-sdk";
import { anthropicOrchestrionConfigs } from "./anthropic";
import { bedrockRuntimeOrchestrionConfigs } from "./bedrock-runtime";
import { claudeAgentSDKOrchestrionConfigs } from "./claude-agent-sdk";
import { cohereOrchestrionConfigs } from "./cohere";
import { cursorSDKOrchestrionConfigs } from "./cursor-sdk";
import { flueOrchestrionConfigs } from "./flue";
import { genkitOrchestrionConfigs } from "./genkit";
import { gitHubCopilotOrchestrionConfigs } from "./github-copilot";
import { googleADKOrchestrionConfigs } from "./google-adk";
import { googleGenAIOrchestrionConfigs } from "./google-genai";
import { groqOrchestrionConfigs } from "./groq";
import { huggingFaceOrchestrionConfigs } from "./huggingface";
import { langchainOrchestrionConfigs } from "./langchain";
import { mistralOrchestrionConfigs } from "./mistral";
import { mastraModuleExportPatchConfigs } from "./mastra";
import { openAIAgentsCoreOrchestrionConfigs } from "./openai-agents";
import { openaiOrchestrionConfigs } from "./openai";
import { openAICodexOrchestrionConfigs } from "./openai-codex";
import { openRouterOrchestrionConfigs } from "./openrouter";
import { openRouterAgentOrchestrionConfigs } from "./openrouter-agent";
import { piCodingAgentOrchestrionConfigs } from "./pi-coding-agent";
import { strandsAgentSDKOrchestrionConfigs } from "./strands-agent-sdk";

interface OrchestrionConfigGroup {
  integrations: readonly (keyof InstrumentationIntegrationsConfig)[];
  configs: readonly InstrumentationConfig[];
}

const defaultOrchestrionConfigGroups: readonly OrchestrionConfigGroup[] = [
  { integrations: ["openai"], configs: openaiOrchestrionConfigs },
  {
    integrations: ["openaiCodexSDK"],
    configs: openAICodexOrchestrionConfigs,
  },
  { integrations: ["anthropic"], configs: anthropicOrchestrionConfigs },
  {
    integrations: ["bedrock", "awsBedrock", "awsBedrockRuntime"],
    configs: bedrockRuntimeOrchestrionConfigs,
  },
  {
    integrations: ["aisdk", "vercel"],
    configs: aiSDKOrchestrionConfigs,
  },
  {
    integrations: ["claudeAgentSDK"],
    configs: claudeAgentSDKOrchestrionConfigs,
  },
  {
    integrations: ["cursor", "cursorSDK"],
    configs: cursorSDKOrchestrionConfigs,
  },
  {
    integrations: ["openAIAgents"],
    configs: openAIAgentsCoreOrchestrionConfigs,
  },
  {
    integrations: ["google", "googleGenAI"],
    configs: googleGenAIOrchestrionConfigs,
  },
  { integrations: ["huggingface"], configs: huggingFaceOrchestrionConfigs },
  {
    integrations: ["langchain", "langgraph"],
    configs: langchainOrchestrionConfigs,
  },
  { integrations: ["openrouter"], configs: openRouterOrchestrionConfigs },
  {
    integrations: ["openrouterAgent"],
    configs: openRouterAgentOrchestrionConfigs,
  },
  { integrations: ["mistral"], configs: mistralOrchestrionConfigs },
  { integrations: ["googleADK"], configs: googleADKOrchestrionConfigs },
  { integrations: ["cohere"], configs: cohereOrchestrionConfigs },
  { integrations: ["groq"], configs: groqOrchestrionConfigs },
  {
    integrations: ["genkit"],
    configs: genkitOrchestrionConfigs,
  },
  {
    integrations: ["gitHubCopilot"],
    configs: gitHubCopilotOrchestrionConfigs,
  },
  {
    integrations: ["piCodingAgent"],
    configs: piCodingAgentOrchestrionConfigs,
  },
  {
    integrations: ["strandsAgentSDK"],
    configs: strandsAgentSDKOrchestrionConfigs,
  },
  {
    integrations: ["flue"],
    configs: flueOrchestrionConfigs,
  },
];

const defaultModuleExportPatchConfigs: readonly ModuleExportPatchConfig[] = [
  ...mastraModuleExportPatchConfigs,
];

export function getDefaultOrchestrionConfigs({
  additionalOrchestrionConfigs,
  disabledIntegrationConfig,
  disabledIntegrations,
}: {
  additionalOrchestrionConfigs?: readonly InstrumentationConfig[];
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
    ...defaultOrchestrionConfigGroups.flatMap(({ configs, integrations }) =>
      isInstrumentationIntegrationDisabled(disabledConfig, ...integrations)
        ? []
        : configs,
    ),
    ...(additionalOrchestrionConfigs ?? []),
  ];
}

export function getDefaultModuleExportPatchConfigs({
  disabledIntegrationConfig,
  target,
}: {
  disabledIntegrationConfig?: InstrumentationIntegrationsConfig;
  target: ModuleExportPatchTarget;
}): ModuleExportPatchConfig[] {
  return filterModuleExportPatchConfigs(defaultModuleExportPatchConfigs, {
    disabledIntegrationConfig,
    target,
  });
}
