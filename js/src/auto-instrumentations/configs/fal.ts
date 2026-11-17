import type { InstrumentationConfig } from "../orchestrion-js";
import { falChannels } from "../../instrumentation/providers/fal-interceptors";

export const falConfigs: InstrumentationConfig[] = [
  {
    channelName: falChannels.createClient.channelName,
    module: {
      name: "@fal-ai/client",
      versionRange: ">=1.10.0 <2.0.0",
      filePath: "src/client.js",
    },
    // Both the default fal singleton and custom clients use this public factory.
    functionQuery: { functionName: "createFalClient" },
  },
];
