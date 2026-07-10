import { braintrustEveInstrumentation, initLogger } from "braintrust";
import { defineState } from "eve/context";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation(
  braintrustEveInstrumentation({
    defineState,
    setup: ({ agentName }) => {
      initLogger({
        projectName: process.env.BRAINTRUST_E2E_PROJECT_NAME || agentName,
      });
    },
  }),
);
