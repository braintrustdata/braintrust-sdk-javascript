const packageName =
  process.env.ANTHROPIC_VERTEX_PACKAGE_NAME || "anthropic-vertex-sdk-v0-latest";
const mod = require(packageName);
const AnthropicVertex = mod.default ?? mod.AnthropicVertex ?? mod;

void (async () => {
  const { runMain } = await import("../../helpers/provider-runtime.mjs");
  const { runAutoAnthropicVertexInstrumentation } =
    await import("./scenario.impl.mjs");

  runMain(async () => {
    await runAutoAnthropicVertexInstrumentation({
      AnthropicVertex,
    });
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
