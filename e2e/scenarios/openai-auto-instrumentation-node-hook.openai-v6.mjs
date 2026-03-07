import OpenAI from "openai";
import { runOpenAIAutoInstrumentationNodeHookOrExit } from "./openai-auto-instrumentation-node-hook.impl.mjs";

runOpenAIAutoInstrumentationNodeHookOrExit(OpenAI, "6.25.0");
