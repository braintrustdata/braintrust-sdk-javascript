import * as strands from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedStrandsAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(() => runWrappedStrandsAgentSDKInstrumentation(strands, OpenAIModel));
