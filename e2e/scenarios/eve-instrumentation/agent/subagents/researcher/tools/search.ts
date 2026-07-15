import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Searches the Eve instrumentation documentation fixture.",
  inputSchema: z.object({
    query: z.string(),
  }),
  async execute({ query }) {
    return {
      query,
      title: "Eve instrumentation",
      url: "https://eve.dev/docs/guides/instrumentation",
    };
  },
});
