const anthropicPackageName =
  process.env.ANTHROPIC_PACKAGE_NAME ?? "anthropic-sdk-v0";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { default: Anthropic } = await import(anthropicPackageName);
  await runWrappedAnthropicInstrumentation(Anthropic, {
    supportsServerToolUse: false,
    useBetaMessages: false,
  });
});
