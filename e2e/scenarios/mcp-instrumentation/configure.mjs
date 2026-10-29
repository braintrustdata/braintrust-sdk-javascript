import { configureInstrumentation } from "braintrust/instrumentation";

configureInstrumentation({
  integrations: {
    mcp: { captureContent: process.env.MCP_CAPTURE_CONTENT === "1" },
  },
  spanCustomizers: [
    {
      onSpanExport(data) {
        data.metadata = {
          ...data.metadata,
          scenario: "mcp-instrumentation",
          testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
        };
        return data;
      },
    },
  ],
});
