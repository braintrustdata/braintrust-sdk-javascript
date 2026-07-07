const githubCopilotPackageName =
  process.env.GITHUB_COPILOT_PACKAGE_NAME ?? "github-copilot-sdk-v0-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runCopilotWrappedInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { CopilotClient, approveAll, defineTool } = await import(
    githubCopilotPackageName
  );
  await runCopilotWrappedInstrumentation({
    CopilotClient,
    approveAll,
    defineTool,
  });
});
