const anthropicBedrockPackageName =
  process.env.ANTHROPIC_BEDROCK_PACKAGE_NAME ??
  "anthropic-bedrock-sdk-v0-latest";
const { default: AnthropicBedrock } = await import(anthropicBedrockPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoAnthropicBedrockInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runAutoAnthropicBedrockInstrumentation({
    AnthropicBedrock,
  });
});
