import type { InstrumentationConfig } from "../orchestrion-js";
import { cursorSDKChannels } from "../../instrumentation/providers/cursor-sdk-interceptors";

const cursorSDKVersionRange = ">=1.0.7 <2.0.0";

const cursorSDKEntrypoints = ["dist/esm/index.js", "dist/cjs/index.js"];

export const cursorSDKConfigs: InstrumentationConfig[] =
  cursorSDKEntrypoints.flatMap((filePath) => [
    {
      channelName: cursorSDKChannels.create.channelName,
      module: {
        name: "@cursor/sdk",
        versionRange: cursorSDKVersionRange,
        filePath,
      },
      functionQuery: {
        className: "Agent",
        methodName: "create",
      },
    },
    {
      channelName: cursorSDKChannels.resume.channelName,
      module: {
        name: "@cursor/sdk",
        versionRange: cursorSDKVersionRange,
        filePath,
      },
      functionQuery: {
        className: "Agent",
        methodName: "resume",
      },
    },
    {
      channelName: cursorSDKChannels.prompt.channelName,
      module: {
        name: "@cursor/sdk",
        versionRange: cursorSDKVersionRange,
        filePath,
      },
      functionQuery: {
        className: "Agent",
        methodName: "prompt",
      },
    },
  ]);
