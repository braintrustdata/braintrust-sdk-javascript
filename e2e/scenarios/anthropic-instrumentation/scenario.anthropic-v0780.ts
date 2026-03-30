import Anthropic from "anthropic-sdk-v0780";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedAnthropicInstrumentation(Anthropic));
