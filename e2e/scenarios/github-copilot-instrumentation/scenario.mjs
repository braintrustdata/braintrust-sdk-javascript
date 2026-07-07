const githubCopilotPackageName =
  process.env.GITHUB_COPILOT_PACKAGE_NAME ?? "github-copilot-sdk-v0-latest";
const { CopilotClient, approveAll, defineTool } = await import(
  githubCopilotPackageName
);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runCopilotAutoInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runCopilotAutoInstrumentation({
    CopilotClient,
    approveAll,
    defineTool,
  });
});
