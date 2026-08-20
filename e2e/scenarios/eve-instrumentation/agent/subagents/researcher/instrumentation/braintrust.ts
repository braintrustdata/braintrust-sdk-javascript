import { braintrustEveInstrumentation, initLogger } from "braintrust";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation(
  braintrustEveInstrumentation({
    metadata: {
      scenario: "eve-instrumentation",
      ...(process.env.BRAINTRUST_E2E_RUN_ID
        ? { testRunId: process.env.BRAINTRUST_E2E_RUN_ID }
        : {}),
    },
    setup: ({ agentName }) => {
      initLogger({
        projectName: process.env.BRAINTRUST_E2E_PROJECT_NAME || agentName,
      });
    },
  }),
);
