import type { InstrumentationConfig } from "../orchestrion-js";
import { typeSafeChannels } from "../../instrumentation/plugins/typesafe-channels";

export const typeSafeConfigs: InstrumentationConfig[] = [
  "dist/index.mjs",
  "dist/index.cjs",
].map((filePath) => ({
  channelName: typeSafeChannels.systemOne.channelName,
  module: {
    name: "@typesafe-ai/sdk",
    versionRange: ">=0.6.0 <1.0.0",
    filePath,
  },
  functionQuery: {
    className: "TypeSafeClient",
    methodName: "systemOne",
    kind: "Async" as const,
  },
}));
