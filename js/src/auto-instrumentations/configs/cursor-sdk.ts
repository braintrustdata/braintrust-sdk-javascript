import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { cursorSDKChannels } from "../../instrumentation/plugins/cursor-sdk-channels";

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
        kind: "Async",
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
        kind: "Async",
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
        kind: "Async",
      },
    },
  ]);
