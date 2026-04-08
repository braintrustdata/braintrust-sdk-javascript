import { OpenRouter } from "@openrouter/agent";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOpenRouterAgentInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoOpenRouterAgentInstrumentation(OpenRouter));
