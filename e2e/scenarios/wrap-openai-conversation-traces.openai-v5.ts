import OpenAI from "openai-v5";
import { runMain } from "./helpers";
import { runWrapOpenAIConversationTraces } from "./wrap-openai-conversation-traces.impl";

runMain(() => runWrapOpenAIConversationTraces(OpenAI, "5.11.0"));
