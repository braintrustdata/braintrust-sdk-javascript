const packageName =
  process.env.ANTHROPIC_BEDROCK_PACKAGE_NAME ||
  "anthropic-bedrock-sdk-v0-latest";
const mod = require(packageName);
const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock ?? mod;

void (async () => {
  const { runMain } = await import("../../helpers/provider-runtime.mjs");
  const { runAutoAnthropicBedrockInstrumentation } =
    await import("./scenario.impl.mjs");

  runMain(async () => {
    await runAutoAnthropicBedrockInstrumentation({
      AnthropicBedrock,
    });
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
