export const spanTypeAttributeValues = [
  "llm",
  "score",
  "function",
  "eval",
  "task",
  "tool",
  "automation",
  "facet",
  "preprocessor",
  "classifier",
  "review",
  "log",
] as const;

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
  LOG = "log",
}

export type SpanType = (typeof spanTypeAttributeValues)[number];

export const spanPurposeAttributeValues = ["scorer"] as const;

export type SpanPurpose = (typeof spanPurposeAttributeValues)[number];
