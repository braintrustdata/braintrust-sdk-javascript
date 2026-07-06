import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Reads a deterministic Eve documentation page fixture.",
  inputSchema: z.object({
    url: z.string(),
  }),
  async execute({ url }) {
    return {
      excerpt:
        "Eve hooks expose runtime stream events that Braintrust maps into a flat turn trace.",
      section: "Runtime context",
      title: "Eve instrumentation",
      url,
    };
  },
});
