import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runCopilotAutoInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runCopilotAutoInstrumentation({
    CopilotClient,
    approveAll,
    defineTool,
  });
});
