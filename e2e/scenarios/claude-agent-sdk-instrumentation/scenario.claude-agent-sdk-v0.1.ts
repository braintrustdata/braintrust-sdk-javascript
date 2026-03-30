import * as claudeAgentSDK from "claude-agent-sdk-v0.1";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedClaudeAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedClaudeAgentSDKInstrumentation(claudeAgentSDK));
