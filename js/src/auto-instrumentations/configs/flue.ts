import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { flueChannels } from "../../instrumentation/plugins/flue-channels";

const flueVersionRange = ">=0.7.0 <0.8.0";

export const flueConfigs: InstrumentationConfig[] = [
  {
    channelName: flueChannels.createContext.channelName,
    module: {
      name: "@flue/runtime",
      versionRange: flueVersionRange,
      filePath: "dist/internal.mjs",
    },
    functionQuery: {
      functionName: "createFlueContext",
      kind: "Sync",
    },
  },
  {
    channelName: flueChannels.openSession.channelName,
    module: {
      name: "@flue/runtime",
      versionRange: flueVersionRange,
      filePath: "dist/internal.mjs",
    },
    functionQuery: {
      className: "Harness",
      methodName: "openSession",
      kind: "Async",
    },
  },
];
