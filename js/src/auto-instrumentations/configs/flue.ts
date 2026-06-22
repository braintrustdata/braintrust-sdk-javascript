import type { InstrumentationConfig } from "../orchestrion-js";
import { flueChannels } from "../../instrumentation/plugins/flue-channels";

const flueVersionRange = ">=0.8.0";

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
];
