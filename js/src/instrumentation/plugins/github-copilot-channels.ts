import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  GitHubCopilotAssistantMessageEvent,
  GitHubCopilotMessageOptions,
  GitHubCopilotResumeSessionConfig,
  GitHubCopilotSession,
  GitHubCopilotSessionConfig,
} from "../../vendor-sdk-types/github-copilot";

export const gitHubCopilotChannels = defineInterceptor("@github/copilot-sdk", {
  createSession: channel<
    [GitHubCopilotSessionConfig],
    PromiseLike<GitHubCopilotSession>
  >({
    channelName: "client.createSession",
  }),
  resumeSession: channel<
    [string, GitHubCopilotResumeSessionConfig],
    PromiseLike<GitHubCopilotSession>
  >({
    channelName: "client.resumeSession",
  }),
  sendAndWait: channel<
    [GitHubCopilotMessageOptions, number?],
    PromiseLike<GitHubCopilotAssistantMessageEvent | undefined>
  >({
    channelName: "session.sendAndWait",
  }),
});
