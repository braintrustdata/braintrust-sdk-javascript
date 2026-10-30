import { configureInstrumentation } from "braintrust/instrumentation";

configureInstrumentation({
  integrations: {
    mcp: process.env.FASTMCP_MCP_ENABLED === "1",
    fastmcp: { captureContent: process.env.MCP_CAPTURE_CONTENT === "1" },
  },
  spanCustomizers: [
    {
      onSpanExport(data) {
        data.metadata = {
          ...data.metadata,
          scenario: "fastmcp-instrumentation",
          testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
        };
        return data;
      },
    },
  ],
});
