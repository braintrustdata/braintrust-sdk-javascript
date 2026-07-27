import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  HuggingFaceTransformersPipeline,
  HuggingFaceTransformersTensor,
} from "../../vendor-sdk-types/huggingface-transformers";

export type HuggingFaceTransformersEventContext = {
  moduleVersion?: string;
  self?: HuggingFaceTransformersPipeline;
};

type HuggingFaceTransformersPipelineInfo = {
  model?: string;
  task: string;
};

const pipelineInfo = new WeakMap<object, HuggingFaceTransformersPipelineInfo>();

export function registerHuggingFaceTransformersPipeline(
  pipeline: HuggingFaceTransformersPipeline,
  task: unknown,
  model: unknown,
): void {
  if (typeof task !== "string") {
    return;
  }

  pipelineInfo.set(pipeline, {
    task,
    ...(typeof model === "string" ? { model } : {}),
  });
}

export function getHuggingFaceTransformersPipelineInfo(
  pipeline: HuggingFaceTransformersPipeline | undefined,
): HuggingFaceTransformersPipelineInfo | undefined {
  return pipeline ? pipelineInfo.get(pipeline) : undefined;
}

export const huggingFaceTransformersChannels = defineChannels(
  "@huggingface/transformers",
  {
    pipeline: channel<
      [string, (string | null)?, Record<string, unknown>?],
      HuggingFaceTransformersPipeline,
      HuggingFaceTransformersEventContext
    >({
      channelName: "pipeline",
      kind: "async",
    }),

    pipelineCall: channel<
      [unknown, ...unknown[]],
      unknown | HuggingFaceTransformersTensor,
      HuggingFaceTransformersEventContext
    >({
      channelName: "pipeline.call",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.HUGGINGFACE },
);
