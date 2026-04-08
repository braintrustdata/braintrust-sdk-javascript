import { OpenRouter } from "@openrouter/agent";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedOpenRouterAgentInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedOpenRouterAgentInstrumentation(OpenRouter));
