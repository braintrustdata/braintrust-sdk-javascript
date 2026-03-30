import Anthropic from "anthropic-sdk-v0730";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoAnthropicInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoAnthropicInstrumentation(Anthropic));
