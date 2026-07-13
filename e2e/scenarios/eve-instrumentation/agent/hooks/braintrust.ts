import { braintrustEveHook } from "braintrust";
import { defineState } from "eve/context";
import { defineHook } from "eve/hooks";

export default defineHook(
  braintrustEveHook({
    defineState,
    metadata: {
      scenario: "eve-instrumentation",
      ...(process.env.BRAINTRUST_E2E_RUN_ID
        ? { testRunId: process.env.BRAINTRUST_E2E_RUN_ID }
        : {}),
    },
  }),
);
