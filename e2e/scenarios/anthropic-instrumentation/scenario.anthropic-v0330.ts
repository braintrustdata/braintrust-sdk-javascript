const anthropicPackageName =
  process.env.ANTHROPIC_PACKAGE_NAME ?? "anthropic-sdk-v0-batches";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { default: Anthropic } = await import(anthropicPackageName);
  await runWrappedAnthropicInstrumentation(Anthropic, {
    supportsBatches: true,
    supportsBetaMessagesStream: false,
    supportsBetaToolRunner: false,
    supportsServerToolUse: false,
    supportsSessions: false,
  });
});
