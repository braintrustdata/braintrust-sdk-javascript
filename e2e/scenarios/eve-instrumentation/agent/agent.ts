import { defineAgent, defineDynamic } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
});

const dynamicModel = openai("gpt-5.4-mini");

export default defineAgent({
  model: defineDynamic({
    fallback: openai("gpt-5.4-mini"),
    events: {
      "step.started": () => dynamicModel,
    },
  }),
  modelContextWindowTokens: 8_192,
});
