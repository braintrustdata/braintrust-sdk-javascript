import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Return STAMP: followed by the given text. Use when the user says STAMP.",
  inputSchema: z.object({
    text: z.string(),
  }),
  async execute({ text }: { text: string }) {
    return `STAMP:${text}`;
  },
});
