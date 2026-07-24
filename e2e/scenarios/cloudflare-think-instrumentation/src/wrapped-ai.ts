import * as ai from "ai-unwrapped";
import { wrapAISDK } from "braintrust";

export * from "ai-unwrapped";

const wrapped = wrapAISDK(ai);

export const streamText = wrapped.streamText;
