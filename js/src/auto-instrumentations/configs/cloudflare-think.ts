import type { InstrumentationConfig } from "../orchestrion-js";
import { cloudflareThinkChannels } from "../../instrumentation/plugins/cloudflare-think-channels";

const cloudflareThinkVersionRange = ">=0.13.0 <0.14.0";

export const cloudflareThinkConfigs: InstrumentationConfig[] = [
  {
    channelName: cloudflareThinkChannels.runInferenceLoop.channelName,
    module: {
      name: "@cloudflare/think",
      versionRange: cloudflareThinkVersionRange,
      filePath: "dist/think.js",
    },
    functionQuery: {
      className: "Think",
      methodName: "_runInferenceLoop",
      kind: "Async",
    },
  },
];
