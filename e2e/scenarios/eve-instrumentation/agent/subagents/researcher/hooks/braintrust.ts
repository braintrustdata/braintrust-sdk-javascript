import { braintrustEveHook } from "braintrust";
import { defineHook } from "eve/hooks";

export default defineHook(
  braintrustEveHook({
    metadata: {
      scenario: "eve-instrumentation",
      ...(process.env.BRAINTRUST_E2E_RUN_ID
        ? { testRunId: process.env.BRAINTRUST_E2E_RUN_ID }
        : {}),
    },
  }),
);
