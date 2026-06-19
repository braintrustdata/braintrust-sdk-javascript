import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoAnthropicBedrockInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runAutoAnthropicBedrockInstrumentation({
    AnthropicBedrock,
  });
});
