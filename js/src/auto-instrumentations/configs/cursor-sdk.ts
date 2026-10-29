import type { InstrumentationConfig } from "../orchestrion-js";
import { cursorSDKChannels } from "../../instrumentation/plugins/cursor-sdk-interceptors";

const cursorSDKVersionRange = ">=1.0.7 <2.0.0";
const cursorSDKEntrypoints = ["dist/esm/index.js", "dist/cjs/index.js"];
const cursorSDKMethods = ["create", "resume", "prompt"] as const;

export const cursorSDKConfigs: InstrumentationConfig[] =
  cursorSDKEntrypoints.flatMap((filePath) =>
    cursorSDKMethods.map((methodName) => ({
      channelName: cursorSDKChannels[methodName].channelName,
      module: {
        name: "@cursor/sdk",
        versionRange: cursorSDKVersionRange,
        filePath,
      },
      functionQuery: {
        classMethods: [...cursorSDKMethods],
        methodName,
      },
    })),
  );
