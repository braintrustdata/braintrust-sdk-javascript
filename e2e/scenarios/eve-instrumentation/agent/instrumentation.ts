import { braintrustEveInstrumentation, initLogger } from "braintrust";
import { defineState } from "eve/context";
import { defineInstrumentation } from "eve/instrumentation";

const instrumentation = braintrustEveInstrumentation({
  defineState,
  setup: ({ agentName }) => {
    initLogger({
      projectName: process.env.BRAINTRUST_E2E_PROJECT_NAME || agentName,
    });
  },
});

export default defineInstrumentation({
  ...instrumentation,
  events: {
    ...instrumentation.events,
    "step.started": (input) => {
      // Eve does not expose the resolved dynamic model yet, so this fixture
      // projects the proposed field at the authored instrumentation boundary.
      instrumentation.events?.["step.started"]?.({
        ...input,
        ...(!input.session.parent
          ? { modelId: "deepseek/deepseek-v4-pro" }
          : {}),
      });
    },
  },
});
