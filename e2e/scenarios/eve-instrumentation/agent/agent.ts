import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
});

export default defineAgent({
  model: openai("gpt-5.4-mini"),
  modelContextWindowTokens: 8_192,
});
