const openRouterAgentPackageName =
  process.env.OPENROUTER_AGENT_PACKAGE_NAME ?? "openrouter-agent-v0-latest";
const { OpenRouter, tool } = await import(openRouterAgentPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOpenRouterAgentInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoOpenRouterAgentInstrumentation(OpenRouter, tool));
