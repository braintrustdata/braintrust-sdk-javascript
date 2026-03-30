import * as claudeAgentSDK from "claude-agent-sdk-v0.1";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoClaudeAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoClaudeAgentSDKInstrumentation(claudeAgentSDK));
