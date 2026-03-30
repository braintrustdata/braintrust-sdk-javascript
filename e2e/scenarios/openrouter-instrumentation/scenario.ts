import { OpenRouter } from "@openrouter/sdk";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedOpenRouterInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedOpenRouterInstrumentation(OpenRouter));
