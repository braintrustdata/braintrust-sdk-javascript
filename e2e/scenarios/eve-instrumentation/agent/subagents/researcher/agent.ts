import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { withReadableReasoning } from "../../reasoning-model";

const openai = createOpenAI({
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
});

export default defineAgent({
  description:
    "Research the Eve instrumentation documentation before the parent reads it.",
  model: withReadableReasoning(openai("gpt-5.4-mini")),
  modelContextWindowTokens: 8_192,
  reasoning: "low",
});
