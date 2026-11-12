import type { InstrumentationConfig } from "../orchestrion-js";
import { googleGenAIChannels } from "../../instrumentation/plugins/google-genai-interceptors";

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
  ...["dist/node/index.mjs", "dist/node/index.cjs", "dist/web/index.mjs"].map(
    (filePath): InstrumentationConfig => ({
      channelName: googleGenAIChannels.decisionsCreate.channelName,
      module: { name: "@google/genai", versionRange: ">=3.2.0", filePath },
      functionQuery: {
        className: "GeminiNextGenDecisions",
        methodName: "create",
      },
    }),
  ),
  // ADK's CommonJS modules load the GenAI CommonJS entrypoint. Capture the
  // underlying model calls as well as the enclosing ADK runner and agents.
  {
    channelName: googleGenAIChannels.generateContent.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.cjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "generateContentInternal",
    },
  },
  {
    channelName: googleGenAIChannels.generateContentStream.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.cjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "generateContentStreamInternal",
    },
  },

  // Models.generateContentInternal - The actual class method (Node.js entry point)
  // Note: generateContent is an arrow function property that calls this internal method
  {
    channelName: googleGenAIChannels.generateContent.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "generateContentInternal",
    },
  },

  // Models.generateContentStreamInternal - The actual class method (Node.js entry point)
  // Note: generateContentStream is an arrow function property that calls this internal method
  {
    channelName: googleGenAIChannels.generateContentStream.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "generateContentStreamInternal",
    },
  },

  // Models.generateImages - public arrow-function property.
  {
    channelName: googleGenAIChannels.generateImages.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      propertyName: "generateImages",
    },
  },

  // Models.editImage - public arrow-function property.
  {
    channelName: googleGenAIChannels.editImage.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      propertyName: "editImage",
    },
  },

  // Models.generateVideos - public arrow-function property. This captures the
  // submission response only and never polls or retrieves media on the user's
  // behalf. Direct-result video generation is covered by BaseInteractions.create.
  {
    channelName: googleGenAIChannels.generateVideos.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      propertyName: "generateVideos",
    },
  },

  // Models.embedContent - class method in older SDK versions
  {
    channelName: googleGenAIChannels.embedContent.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0 <1.44.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "embedContent",
    },
  },

  // Models.embedContentInternal - class method in newer SDK versions
  // Note: embedContent is an arrow function property that calls this method
  {
    channelName: googleGenAIChannels.embedContent.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.44.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "Models",
      methodName: "embedContentInternal",
    },
  },

  // The SDK's embedding response converter drops usageMetadata. Observe the
  // parsed HTTP response before conversion; the plugin scopes this to embeddings.
  {
    channelName: googleGenAIChannels.httpResponseJson.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.0.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "HttpResponse",
      methodName: "json",
    },
  },

  // BaseInteractions.create - Interactions API entry point
  {
    channelName: googleGenAIChannels.interactionsCreate.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=1.33.0 <2.9.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "BaseInteractions",
      methodName: "create",
    },
  },

  // SDK 2.9 replaced BaseInteractions with the public Interactions bridge.
  // Trace the bridge once, including streaming and automatic continuation,
  // rather than its underlying HTTP requests.
  {
    channelName: googleGenAIChannels.interactionsCreate.channelName,
    module: {
      name: "@google/genai",
      versionRange: ">=2.9.0",
      filePath: "dist/node/index.mjs",
    },
    functionQuery: {
      className: "GeminiNextGenInteractions",
      methodName: "create",
    },
  },
];
