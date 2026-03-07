import OpenAI from "openai-v4";
import { runMain } from "./helpers";
import { runWrapOpenAIConversationTraces } from "./wrap-openai-conversation-traces.impl";

runMain(() => runWrapOpenAIConversationTraces(OpenAI, "4.104.0"));
