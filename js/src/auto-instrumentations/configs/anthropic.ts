import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { anthropicChannels } from "../../instrumentation/plugins/anthropic-channels";

/**
 * Instrumentation configurations for the Anthropic SDK.
 *
 * These configs define which functions to instrument and what channel
 * to emit events on. They are used by orchestrion-js to perform AST
 * transformation at build-time or load-time.
 *
 * NOTE: Channel names should NOT include the orchestrion: prefix. The code-transformer
 * will prepend "orchestrion:" + module.name + ":" to these names, resulting in final channel names like:
 * "orchestrion:@anthropic-ai/sdk:messages.create"
 */
export const anthropicConfigs: InstrumentationConfig[] = [
  // Messages API - create (supports streaming via stream=true parameter)
  {
    channelName: anthropicChannels.messagesCreate.name,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.60.0",
      filePath: "resources/messages/messages.mjs",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },

  // Beta Messages API - create (supports streaming via stream=true parameter)
  {
    channelName: anthropicChannels.betaMessagesCreate.name,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.60.0",
      filePath: "resources/beta/messages/messages.mjs",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },
];
