const anthropicPackageName =
  process.env.ANTHROPIC_PACKAGE_NAME ?? "anthropic-sdk-v0-batches";
const { default: Anthropic } = await import(anthropicPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoAnthropicInstrumentation(Anthropic, {
    supportsBatches: true,
    supportsBetaMessagesStream: false,
    supportsBetaToolRunner: false,
    supportsServerToolUse: false,
    supportsSessions: false,
  }),
);
