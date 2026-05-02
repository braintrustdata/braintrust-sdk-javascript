import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { gitHubCopilotChannels } from "../../instrumentation/plugins/github-copilot-channels";

export const gitHubCopilotConfigs: InstrumentationConfig[] = [
  // ESM: CopilotClient.createSession
  {
    channelName: gitHubCopilotChannels.createSession.channelName,
    module: {
      name: "@github/copilot-sdk",
      versionRange: ">=0.3.0",
      filePath: "dist/client.js",
    },
    functionQuery: {
      className: "CopilotClient",
      methodName: "createSession",
      kind: "Async",
    },
  },
  // CJS: CopilotClient.createSession
  {
    channelName: gitHubCopilotChannels.createSession.channelName,
    module: {
      name: "@github/copilot-sdk",
      versionRange: ">=0.3.0",
      filePath: "dist/cjs/client.js",
    },
    functionQuery: {
      className: "CopilotClient",
      methodName: "createSession",
      kind: "Async",
    },
  },
  // ESM: CopilotClient.resumeSession
  {
    channelName: gitHubCopilotChannels.resumeSession.channelName,
    module: {
      name: "@github/copilot-sdk",
      versionRange: ">=0.3.0",
      filePath: "dist/client.js",
    },
    functionQuery: {
      className: "CopilotClient",
      methodName: "resumeSession",
      kind: "Async",
    },
  },
  // CJS: CopilotClient.resumeSession
  {
    channelName: gitHubCopilotChannels.resumeSession.channelName,
    module: {
      name: "@github/copilot-sdk",
      versionRange: ">=0.3.0",
      filePath: "dist/cjs/client.js",
    },
    functionQuery: {
      className: "CopilotClient",
      methodName: "resumeSession",
      kind: "Async",
    },
  },
  // ESM: CopilotSession.sendAndWait
  {
    channelName: gitHubCopilotChannels.sendAndWait.channelName,
    module: {
      name: "@github/copilot-sdk",
      versionRange: ">=0.3.0",
      filePath: "dist/session.js",
    },
    functionQuery: {
      className: "CopilotSession",
      methodName: "sendAndWait",
      kind: "Async",
    },
  },
  // CJS: CopilotSession.sendAndWait
  {
    channelName: gitHubCopilotChannels.sendAndWait.channelName,
    module: {
      name: "@github/copilot-sdk",
      versionRange: ">=0.3.0",
      filePath: "dist/cjs/session.js",
    },
    functionQuery: {
      className: "CopilotSession",
      methodName: "sendAndWait",
      kind: "Async",
    },
  },
];
