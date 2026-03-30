import * as claudeAgentSDK from "claude-agent-sdk-v0.2.81";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoClaudeAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoClaudeAgentSDKInstrumentation(claudeAgentSDK));
