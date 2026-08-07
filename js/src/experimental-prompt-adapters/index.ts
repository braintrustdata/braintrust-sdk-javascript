import { aiSDKGenerateObjectAdapter } from "./ai-sdk";
import { openAIChatAdapter } from "./openai";

export { aiSDKGenerateObjectAdapter, openAIChatAdapter };

export const adapters = {
  openAIChat: openAIChatAdapter,
  aiSDKGenerateObject: aiSDKGenerateObjectAdapter,
};
