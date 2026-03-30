import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { claudeAgentSDKChannels } from "../../instrumentation/plugins/claude-agent-sdk-channels";

/**
 * Instrumentation configuration for the Claude Agent SDK.
 *
 * This config defines which functions to instrument and what channel
 * to emit events on. It is used by orchestrion-js to perform AST
 * transformation at build-time or load-time.
 *
 * NOTE: Channel names should NOT include the braintrust: prefix. The code-transformer
 * will prepend "orchestrion:claude-agent-sdk:" to these names, resulting in final channel
 * names like: "orchestrion:claude-agent-sdk:query"
 */
export const claudeAgentSDKConfigs: InstrumentationConfig[] = [
  // query - Main entry point for agent interactions. The SDK returns an async
  // iterable, but the exported query function itself is synchronous.
  {
    channelName: claudeAgentSDKChannels.query.channelName,
    module: {
      name: "@anthropic-ai/claude-agent-sdk",
      versionRange: ">=0.1.0 <0.2.0",
      filePath: "sdk.mjs",
    },
    functionQuery: {
      functionName: "query",
      kind: "Sync",
    },
  },
  {
    channelName: claudeAgentSDKChannels.query.channelName,
    module: {
      name: "@anthropic-ai/claude-agent-sdk",
      versionRange: ">=0.2.0",
      filePath: "sdk.mjs",
    },
    functionQuery: {
      functionName: "query",
      kind: "Sync",
      isExportAlias: true,
    },
  },
];
