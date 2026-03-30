import { OpenRouter } from "@openrouter/sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOpenRouterInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoOpenRouterInstrumentation(OpenRouter));
