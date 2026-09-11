const anthropicVertexPackageName =
  process.env.ANTHROPIC_VERTEX_PACKAGE_NAME ?? "anthropic-vertex-sdk-v0-latest";
const { default: AnthropicVertex } = await import(anthropicVertexPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoAnthropicVertexInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runAutoAnthropicVertexInstrumentation({
    AnthropicVertex,
  });
});
