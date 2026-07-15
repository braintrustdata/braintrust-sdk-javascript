import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openai = createOpenAI({
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
});

export default defineAgent({
  description:
    "Research the Eve instrumentation documentation before the parent reads it.",
  model: openai("gpt-5.4-mini"),
  modelContextWindowTokens: 8_192,
});
