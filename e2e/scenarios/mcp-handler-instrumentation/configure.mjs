import { configureInstrumentation } from "braintrust/instrumentation";

configureInstrumentation({
  integrations: {
    mcp: process.env.MCP_ENABLED === "1",
    mcpHandler:
      process.env.MCP_HANDLER_DISABLED === "1"
        ? false
        : { captureContent: process.env.MCP_CAPTURE_CONTENT === "1" },
  },
  spanCustomizers: [
    {
      onSpanExport(data) {
        data.metadata = {
          ...data.metadata,
          scenario: "mcp-handler-instrumentation",
          testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
        };
        return data;
      },
    },
  ],
});
