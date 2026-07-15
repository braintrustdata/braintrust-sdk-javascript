const claudeAgentSDKPackageName =
  process.env.CLAUDE_AGENT_SDK_PACKAGE_NAME ?? "claude-agent-sdk-v0";
const claudeAgentSDK = await import(claudeAgentSDKPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoClaudeAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoClaudeAgentSDKInstrumentation(claudeAgentSDK));
