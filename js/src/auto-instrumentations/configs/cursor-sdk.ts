import type { InstrumentationConfig } from "../orchestrion-js";
import { cursorSDKChannels } from "../../instrumentation/plugins/cursor-sdk-interceptors";

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
        // Published builds minify the class and re-export it, as
        // `export { Fe as Agent }` in ESM and `r.d(exports, { Agent: () => te })`
        // in CommonJS. The alias resolves that local name.
        isExportAlias: true,
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
        isExportAlias: true,
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
        isExportAlias: true,
      },
    },
  ]);
