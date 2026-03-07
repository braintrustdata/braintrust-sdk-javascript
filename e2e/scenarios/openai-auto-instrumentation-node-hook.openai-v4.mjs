import OpenAI from "openai-v4";
import { runOpenAIAutoInstrumentationNodeHookOrExit } from "./openai-auto-instrumentation-node-hook.impl.mjs";

runOpenAIAutoInstrumentationNodeHookOrExit(OpenAI, "4.104.0");
