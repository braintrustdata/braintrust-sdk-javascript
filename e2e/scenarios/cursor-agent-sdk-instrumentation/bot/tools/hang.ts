import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Sleep until the turn is cancelled. Use only when the user says HANG.",
  inputSchema: z.object({}),
  async execute() {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 45_000);
      timer.unref?.();
    });
    return "HANG_FINISHED";
  },
});
