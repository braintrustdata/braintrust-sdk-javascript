import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { googleGenAIChannels } from "../../instrumentation/plugins/google-genai-channels";

/**
 * Instrumentation configurations for the Google GenAI SDK.
 *
 * These configs define which functions to instrument and what channel
 * to emit events on. They are used by orchestrion-js to perform AST
 * transformation at build-time or load-time.
 *
 * NOTE: Channel names should NOT include the braintrust: prefix. The code-transformer
 * will prepend "orchestrion:google-genai:" to these names, resulting in final channel names like:
 * "orchestrion:google-genai:models.generateContent"
 */
export const googleGenAIConfigs: InstrumentationConfig[] = [
  // Models.generateContentInternal - The actual class method (Node.js entry point)
  // Note: generateContent is an arrow function property that calls this internal method
  {
    channelName: googleGenAIChannels.generateContent.name,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "generateContentInternal",
      kind: "Async",
    },
  },

  // Models.generateContentStreamInternal - The actual class method (Node.js entry point)
  // Note: generateContentStream is an arrow function property that calls this internal method
  {
    channelName: googleGenAIChannels.generateContentStream.name,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "generateContentStreamInternal",
      kind: "Async",
    },
  },
];
