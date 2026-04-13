import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { huggingFaceChannels } from "../../instrumentation/plugins/huggingface-channels";

export const huggingFaceConfigs: InstrumentationConfig[] = [
  {
    channelName: huggingFaceChannels.chatCompletion.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "chatCompletion",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.chatCompletion.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.cjs",
    },
    functionQuery: {
      functionName: "chatCompletion",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.chatCompletionStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "chatCompletionStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.chatCompletionStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.cjs",
    },
    functionQuery: {
      functionName: "chatCompletionStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.textGeneration.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "textGeneration",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.textGeneration.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.cjs",
    },
    functionQuery: {
      functionName: "textGeneration",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.textGenerationStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "textGenerationStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.textGenerationStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.cjs",
    },
    functionQuery: {
      functionName: "textGenerationStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.featureExtraction.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "featureExtraction",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.featureExtraction.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=2.0.0 <3.0.0",
      filePath: "dist/index.cjs",
    },
    functionQuery: {
      functionName: "featureExtraction",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.chatCompletion.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/esm/tasks/nlp/chatCompletion.js",
    },
    functionQuery: {
      functionName: "chatCompletion",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.chatCompletion.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/commonjs/tasks/nlp/chatCompletion.js",
    },
    functionQuery: {
      functionName: "chatCompletion",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.chatCompletionStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/esm/tasks/nlp/chatCompletionStream.js",
    },
    functionQuery: {
      functionName: "chatCompletionStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.chatCompletionStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/commonjs/tasks/nlp/chatCompletionStream.js",
    },
    functionQuery: {
      functionName: "chatCompletionStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.textGeneration.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/esm/tasks/nlp/textGeneration.js",
    },
    functionQuery: {
      functionName: "textGeneration",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.textGeneration.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/commonjs/tasks/nlp/textGeneration.js",
    },
    functionQuery: {
      functionName: "textGeneration",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.textGenerationStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/esm/tasks/nlp/textGenerationStream.js",
    },
    functionQuery: {
      functionName: "textGenerationStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.textGenerationStream.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/commonjs/tasks/nlp/textGenerationStream.js",
    },
    functionQuery: {
      functionName: "textGenerationStream",
      kind: "Sync",
    },
  },
  {
    channelName: huggingFaceChannels.featureExtraction.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/esm/tasks/nlp/featureExtraction.js",
    },
    functionQuery: {
      functionName: "featureExtraction",
      kind: "Async",
    },
  },
  {
    channelName: huggingFaceChannels.featureExtraction.channelName,
    module: {
      name: "@huggingface/inference",
      versionRange: ">=3.0.0 <5.0.0",
      filePath: "dist/commonjs/tasks/nlp/featureExtraction.js",
    },
    functionQuery: {
      functionName: "featureExtraction",
      kind: "Async",
    },
  },
];
