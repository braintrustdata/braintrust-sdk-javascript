import * as OpenAICodexSDK from "./node_modules/openai-codex-sdk-v0128/dist/index.js";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedOpenAICodexInstrumentation } from "./scenario.impl.mjs";

runMain(() => runWrappedOpenAICodexInstrumentation(OpenAICodexSDK));
