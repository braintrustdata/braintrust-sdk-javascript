import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedAnthropicBedrockInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runWrappedAnthropicBedrockInstrumentation({
    AnthropicBedrock,
  });
});
