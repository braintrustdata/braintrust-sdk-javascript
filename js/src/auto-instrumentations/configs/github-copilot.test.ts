import { describe, expect, it } from "vitest";
import { gitHubCopilotChannels } from "../../instrumentation/plugins/github-copilot-channels";
import { gitHubCopilotConfigs } from "./github-copilot";

function findConfigsByMethod(methodName: string) {
  return gitHubCopilotConfigs.filter((config) => {
    if (!("functionQuery" in config)) {
      return false;
    }
    const query = config.functionQuery as { methodName?: string };
    return query.methodName === methodName;
  });
}

describe("gitHubCopilotConfigs", () => {
  it("defines channels for createSession, resumeSession, sendAndWait", () => {
    expect(gitHubCopilotChannels.createSession.channelName).toContain(
      "createSession",
    );
    expect(gitHubCopilotChannels.resumeSession.channelName).toContain(
      "resumeSession",
    );
    expect(gitHubCopilotChannels.sendAndWait.channelName).toContain(
      "sendAndWait",
    );
  });

  it("instruments createSession in both ESM and CJS", () => {
    const configs = findConfigsByMethod("createSession");
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.channelName)).toEqual([
      gitHubCopilotChannels.createSession.channelName,
      gitHubCopilotChannels.createSession.channelName,
    ]);
    expect(configs.map((c) => c.module.filePath).sort()).toEqual([
      "dist/cjs/client.js",
      "dist/client.js",
    ]);
    for (const config of configs) {
      expect(config.module.name).toBe("@github/copilot-sdk");
      expect(config.module.versionRange).toBe(">=0.3.0");
      expect((config.functionQuery as { className?: string }).className).toBe(
        "CopilotClient",
      );
    }
  });

  it("instruments resumeSession in both ESM and CJS", () => {
    const configs = findConfigsByMethod("resumeSession");
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.channelName)).toEqual([
      gitHubCopilotChannels.resumeSession.channelName,
      gitHubCopilotChannels.resumeSession.channelName,
    ]);
    expect(configs.map((c) => c.module.filePath).sort()).toEqual([
      "dist/cjs/client.js",
      "dist/client.js",
    ]);
    for (const config of configs) {
      expect((config.functionQuery as { className?: string }).className).toBe(
        "CopilotClient",
      );
    }
  });

  it("instruments sendAndWait in both ESM and CJS", () => {
    const configs = findConfigsByMethod("sendAndWait");
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.channelName)).toEqual([
      gitHubCopilotChannels.sendAndWait.channelName,
      gitHubCopilotChannels.sendAndWait.channelName,
    ]);
    expect(configs.map((c) => c.module.filePath).sort()).toEqual([
      "dist/cjs/session.js",
      "dist/session.js",
    ]);
    for (const config of configs) {
      expect((config.functionQuery as { className?: string }).className).toBe(
        "CopilotSession",
      );
    }
  });

  it("all configs target @github/copilot-sdk >=0.3.0", () => {
    for (const config of gitHubCopilotConfigs) {
      expect(config.module.name).toBe("@github/copilot-sdk");
      expect(config.module.versionRange).toBe(">=0.3.0");
    }
  });
});
