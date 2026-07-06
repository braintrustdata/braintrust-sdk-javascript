import { initLogger } from "braintrust";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup: ({ agentName }) => {
    initLogger({
      projectName: process.env.BRAINTRUST_E2E_PROJECT_NAME || agentName,
    });
  },
});
