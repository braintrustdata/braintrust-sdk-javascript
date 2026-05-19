import * as OpenAICodexSDK from "./node_modules/openai-codex-sdk-v0128/dist/index.js";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOpenAICodexInstrumentation } from "./scenario.impl.mjs";

runMain(() => runAutoOpenAICodexInstrumentation(OpenAICodexSDK));
