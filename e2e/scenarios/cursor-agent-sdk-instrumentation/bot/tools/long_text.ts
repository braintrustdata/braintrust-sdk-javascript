import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";

const body = `LONG_MARKER:${"x".repeat(3000)}`;

export default defineTool({
  description:
    "Return a marker plus more than 2048 characters. Use when the user says LONG.",
  inputSchema: z.object({}),
  async execute() {
    return body;
  },
});
