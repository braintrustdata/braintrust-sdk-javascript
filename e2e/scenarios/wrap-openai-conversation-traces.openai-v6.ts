import OpenAI from "openai";
import { runMain } from "./helpers";
import { runWrapOpenAIConversationTraces } from "./wrap-openai-conversation-traces.impl";

runMain(() => runWrapOpenAIConversationTraces(OpenAI, "6.25.0"));
