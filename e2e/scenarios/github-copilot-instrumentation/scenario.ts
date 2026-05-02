import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runCopilotWrappedInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runCopilotWrappedInstrumentation({
    CopilotClient,
    approveAll,
    defineTool,
  });
});
