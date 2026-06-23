const DEFAULT_MODEL = "us.amazon.nova-lite-v1:0";

function getModel() {
  const cassetteMode = process.env.BRAINTRUST_E2E_CASSETTE_MODE;
  if (
    (cassetteMode === "record" ||
      cassetteMode === "record-missing" ||
      cassetteMode === "passthrough") &&
    process.env.BRAINTRUST_BEDROCK_CONVERSE_MODEL
  ) {
    return process.env.BRAINTRUST_BEDROCK_CONVERSE_MODEL;
  }

  return DEFAULT_MODEL;
}

export const MODEL = getModel();
export const REGION =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
export const CACHE_PROMPT_MARKER = "BRAINTRUST_BEDROCK_CACHE_CONTEXT";
export const ROOT_NAME = "bedrock-runtime-instrumentation-root";
export const SCENARIO_NAME = "bedrock-runtime-instrumentation";
