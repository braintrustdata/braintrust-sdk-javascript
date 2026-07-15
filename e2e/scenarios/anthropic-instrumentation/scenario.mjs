const anthropicPackageName =
  process.env.ANTHROPIC_PACKAGE_NAME ?? "anthropic-sdk-v0-latest";
const { default: Anthropic } = await import(anthropicPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoAnthropicInstrumentation(Anthropic, {
    supportsThinking: true,
  }),
);
