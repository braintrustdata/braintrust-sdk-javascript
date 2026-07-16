import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";
import { withReadableReasoning } from "./reasoning-model";

const openai = createOpenAI({
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
});

const dynamicModel = withReadableReasoning(openai("gpt-5.4-mini"));

export default defineAgent({
  model: defineDynamic({
    fallback: dynamicModel,
    events: {
      "step.started": () => dynamicModel,
    },
  }),
  modelContextWindowTokens: 8_192,
  reasoning: "low",
});
