import OpenAI from "openai-v5";
import { runOpenAIAutoInstrumentationNodeHookOrExit } from "./openai-auto-instrumentation-node-hook.impl.mjs";

runOpenAIAutoInstrumentationNodeHookOrExit(OpenAI, "5.11.0");
