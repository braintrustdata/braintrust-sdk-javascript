import Anthropic from "anthropic-sdk-v0712";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedAnthropicInstrumentation(Anthropic));
