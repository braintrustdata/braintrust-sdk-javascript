import Anthropic from "@anthropic-ai/sdk";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedAnthropicInstrumentation(Anthropic));
