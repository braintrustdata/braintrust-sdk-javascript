export type HuggingFaceTransformersTask =
  | "text-generation"
  | "text2text-generation"
  | "summarization"
  | "feature-extraction"
  | "question-answering";

export interface HuggingFaceTransformersTensor {
  dims?: readonly number[];
  data?: ArrayLike<number>;
  tolist?: () => unknown;
  [key: string]: unknown;
}

export interface HuggingFaceTransformersModel {
  config?: Record<string, unknown>;
  name?: string;
  [key: string]: unknown;
}

export interface HuggingFaceTransformersPipeline {
  (...args: unknown[]): Promise<unknown>;
  task?: string;
  model?: HuggingFaceTransformersModel;
  tokenizer?: unknown;
  [key: string]: unknown;
}

export interface HuggingFaceTransformersPipelineConstructor {
  new (...args: unknown[]): HuggingFaceTransformersPipeline;
}

export interface HuggingFaceTransformersModule {
  pipeline?: (
    task: string,
    model?: string | null,
    options?: Record<string, unknown>,
  ) => Promise<HuggingFaceTransformersPipeline>;
  TextGenerationPipeline?: HuggingFaceTransformersPipelineConstructor;
  Text2TextGenerationPipeline?: HuggingFaceTransformersPipelineConstructor;
  SummarizationPipeline?: HuggingFaceTransformersPipelineConstructor;
  FeatureExtractionPipeline?: HuggingFaceTransformersPipelineConstructor;
  QuestionAnsweringPipeline?: HuggingFaceTransformersPipelineConstructor;
  [key: string]: unknown;
}
