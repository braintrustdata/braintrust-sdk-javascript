import Anthropic from "@anthropic-ai/sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoAnthropicInstrumentation(Anthropic));
