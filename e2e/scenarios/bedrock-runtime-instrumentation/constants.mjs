export const MODEL =
  process.env.BRAINTRUST_BEDROCK_CONVERSE_MODEL ?? "us.amazon.nova-lite-v1:0";
export const REGION =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
export const ROOT_NAME = "bedrock-runtime-instrumentation-root";
export const SCENARIO_NAME = "bedrock-runtime-instrumentation";
