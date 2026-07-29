import type { InstrumentationConfig } from "../orchestrion-js";
import { huggingFaceTransformersChannels } from "../../instrumentation/plugins/huggingface-transformers-channels";

const moduleFiles = [
  {
    filePath: "dist/transformers.mjs",
    versionRange: ">=3.0.0 <3.4.0",
  },
  {
    filePath: "dist/transformers.cjs",
    versionRange: ">=3.0.0 <3.4.0",
  },
  {
    filePath: "dist/transformers.js",
    versionRange: ">=3.0.0 <3.4.0",
  },
  {
    filePath: "dist/transformers.node.mjs",
    versionRange: ">=3.4.0 <5.0.0",
  },
  {
    filePath: "dist/transformers.node.cjs",
    versionRange: ">=3.4.0 <5.0.0",
  },
  {
    filePath: "dist/transformers.web.js",
    versionRange: ">=3.4.0 <5.0.0",
  },
] as const;
const pipelineClasses = [
  "TextGenerationPipeline",
  "Text2TextGenerationPipeline",
  "FeatureExtractionPipeline",
  "QuestionAnsweringPipeline",
] as const;

export const huggingFaceTransformersConfigs: InstrumentationConfig[] =
  moduleFiles.flatMap(({ filePath, versionRange }) => [
    {
      channelName: huggingFaceTransformersChannels.pipeline.channelName,
      module: {
        name: "@huggingface/transformers",
        versionRange,
        filePath,
      },
      functionQuery: {
        functionName: "pipeline",
        kind: "Async",
      },
    },
    ...pipelineClasses.map((className) => ({
      channelName: huggingFaceTransformersChannels.pipelineCall.channelName,
      module: {
        name: "@huggingface/transformers",
        versionRange,
        filePath,
      },
      functionQuery: {
        className,
        methodName: "_call",
        kind: "Async" as const,
      },
    })),
  ]);
