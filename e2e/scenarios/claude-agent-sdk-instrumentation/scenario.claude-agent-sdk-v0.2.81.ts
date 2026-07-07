const claudeAgentSDKPackageName =
  process.env.CLAUDE_AGENT_SDK_PACKAGE_NAME ?? "claude-agent-sdk-v0-latest";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedClaudeAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const claudeAgentSDK = await import(claudeAgentSDKPackageName);
  await runWrappedClaudeAgentSDKInstrumentation(claudeAgentSDK);
});
