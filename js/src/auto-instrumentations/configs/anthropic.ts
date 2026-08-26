import type { InstrumentationConfig } from "../orchestrion-js";
import { anthropicChannels } from "../../instrumentation/providers/anthropic-channels";

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
  // Each logical target is listed for both published module formats:
  // `.mjs` covers ESM imports, while `.js` covers CJS requires. The Bedrock
  // SDK delegates CJS `messages.create` calls through these Anthropic SDK
  // `.js` resource files.

  // Messages API - create in older SDK layouts (supports streaming via stream=true parameter)
  {
    channelName: anthropicChannels.messagesCreate.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.27.0 <0.39.0",
      filePath: "resources/messages.mjs",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },
  {
    channelName: anthropicChannels.messagesCreate.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.27.0 <0.39.0",
      filePath: "resources/messages.js",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },

  // Messages API - create (supports streaming via stream=true parameter)
  {
    channelName: anthropicChannels.messagesCreate.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.39.0",
      filePath: "resources/messages/messages.mjs",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },
  {
    channelName: anthropicChannels.messagesCreate.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.39.0",
      filePath: "resources/messages/messages.js",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },

  // Beta Messages API - create (supports streaming via stream=true parameter)
  {
    channelName: anthropicChannels.betaMessagesCreate.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.39.0",
      filePath: "resources/beta/messages/messages.mjs",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },
  {
    channelName: anthropicChannels.betaMessagesCreate.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.39.0",
      filePath: "resources/beta/messages/messages.js",
    },
    functionQuery: {
      className: "Messages",
      methodName: "create",
      kind: "Async",
    },
  },

  // Beta Messages API - toolRunner (sync helper returning async iterable/thenable)
  {
    channelName: anthropicChannels.betaMessagesToolRunner.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.39.0",
      filePath: "resources/beta/messages/messages.mjs",
    },
    functionQuery: {
      className: "Messages",
      methodName: "toolRunner",
      kind: "Sync",
    },
  },
  {
    channelName: anthropicChannels.betaMessagesToolRunner.channelName,
    module: {
      name: "@anthropic-ai/sdk",
      versionRange: ">=0.39.0",
      filePath: "resources/beta/messages/messages.js",
    },
    functionQuery: {
      className: "Messages",
      methodName: "toolRunner",
      kind: "Sync",
    },
  },

  // Managed Agents Sessions event streams are discovered automatically, but
  // remain passive until the user calls collectAnthropicSession() on the
  // returned stream.
  ...["mjs", "js"].map(
    (extension): InstrumentationConfig => ({
      channelName: anthropicChannels.betaSessionsEventsStream.channelName,
      module: {
        name: "@anthropic-ai/sdk",
        versionRange: ">=0.86.0",
        filePath: `resources/beta/sessions/events.${extension}`,
      },
      functionQuery: {
        className: "Events",
        methodName: "stream",
        kind: "Async",
      },
    }),
  ),
  ...["mjs", "js"].map(
    (extension): InstrumentationConfig => ({
      channelName:
        anthropicChannels.betaSessionsThreadsEventsStream.channelName,
      module: {
        name: "@anthropic-ai/sdk",
        versionRange: ">=0.86.0",
        filePath: `resources/beta/sessions/threads/events.${extension}`,
      },
      functionQuery: {
        className: "Events",
        methodName: "stream",
        kind: "Async",
      },
    }),
  ),
];
