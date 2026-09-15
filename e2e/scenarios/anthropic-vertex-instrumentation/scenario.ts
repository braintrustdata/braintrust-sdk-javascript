const anthropicVertexPackageName =
  process.env.ANTHROPIC_VERTEX_PACKAGE_NAME ?? "anthropic-vertex-sdk-v0-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedAnthropicVertexInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { default: AnthropicVertex } = await import(anthropicVertexPackageName);
  await runWrappedAnthropicVertexInstrumentation({
    AnthropicVertex,
  });
});
