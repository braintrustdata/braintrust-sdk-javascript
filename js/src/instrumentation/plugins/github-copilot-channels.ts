import { channel, defineChannels } from "../core/channel-definitions";
import type {
  GitHubCopilotAssistantMessageEvent,
  GitHubCopilotMessageOptions,
  GitHubCopilotResumeSessionConfig,
  GitHubCopilotSession,
  GitHubCopilotSessionConfig,
} from "../../vendor-sdk-types/github-copilot";

export const gitHubCopilotChannels = defineChannels("@github/copilot-sdk", {
  createSession: channel<[GitHubCopilotSessionConfig], GitHubCopilotSession>({
    channelName: "client.createSession",
    kind: "async",
  }),
  resumeSession: channel<
    [string, GitHubCopilotResumeSessionConfig],
    GitHubCopilotSession
  >({
    channelName: "client.resumeSession",
    kind: "async",
  }),
  sendAndWait: channel<
    [GitHubCopilotMessageOptions, number?],
    GitHubCopilotAssistantMessageEvent | undefined
  >({
    channelName: "session.sendAndWait",
    kind: "async",
  }),
});
