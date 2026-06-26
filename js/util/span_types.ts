import {
  type SpanPurposeAttributeMapType,
  type SpanPurposeType,
  type SpanTypeAttributeMapType,
  type SpanTypeType,
} from "../src/generated_types";

// DEPRECATED: Use `spanTypeAttributeValues` instead
export enum SpanTypeAttribute {
  LLM = "llm",
  SCORE = "score",
  FUNCTION = "function",
  EVAL = "eval",
  TASK = "task",
  TOOL = "tool",
  AUTOMATION = "automation",
  FACET = "facet",
  PREPROCESSOR = "preprocessor",
  CLASSIFIER = "classifier",
  REVIEW = "review",
}

const spanTypeAttributeMap: SpanTypeAttributeMapType = {
  LLM: SpanTypeAttribute.LLM,
  SCORE: SpanTypeAttribute.SCORE,
  FUNCTION: SpanTypeAttribute.FUNCTION,
  EVAL: SpanTypeAttribute.EVAL,
  TASK: SpanTypeAttribute.TASK,
  TOOL: SpanTypeAttribute.TOOL,
  AUTOMATION: SpanTypeAttribute.AUTOMATION,
  FACET: SpanTypeAttribute.FACET,
  PREPROCESSOR: SpanTypeAttribute.PREPROCESSOR,
  CLASSIFIER: SpanTypeAttribute.CLASSIFIER,
  REVIEW: SpanTypeAttribute.REVIEW,
};

export const spanTypeAttributeValues = Object.freeze(
  Object.values(spanTypeAttributeMap),
);

export type SpanType = Exclude<SpanTypeType, null>;

const spanPurposeAttributeMap: SpanPurposeAttributeMapType = {
  SCORER: "scorer",
};

export const spanPurposeAttributeValues = Object.freeze(
  Object.values(spanPurposeAttributeMap),
);

export type SpanPurpose = Exclude<SpanPurposeType, null>;
