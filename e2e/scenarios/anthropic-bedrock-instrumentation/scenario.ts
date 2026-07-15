const anthropicBedrockPackageName =
  process.env.ANTHROPIC_BEDROCK_PACKAGE_NAME ??
  "anthropic-bedrock-sdk-v0-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedAnthropicBedrockInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { default: AnthropicBedrock } = await import(
    anthropicBedrockPackageName
  );
  await runWrappedAnthropicBedrockInstrumentation({
    AnthropicBedrock,
  });
});
