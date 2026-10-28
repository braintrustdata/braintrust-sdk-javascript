import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";

export default defineTool({
  description: "Fail on purpose. Use only when the user says FAIL.",
  inputSchema: z.object({}),
  async execute() {
    throw new Error("fail_tool exploded");
  },
});
