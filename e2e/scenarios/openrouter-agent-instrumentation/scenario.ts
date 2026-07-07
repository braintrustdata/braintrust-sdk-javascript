const openRouterAgentPackageName =
  process.env.OPENROUTER_AGENT_PACKAGE_NAME ?? "openrouter-agent-v0-latest";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedOpenRouterAgentInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { OpenRouter, tool } = await import(openRouterAgentPackageName);
  await runWrappedOpenRouterAgentInstrumentation(OpenRouter, tool);
});
