import * as claudeAgentSDK from "claude-agent-sdk-v0.2.81";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedClaudeAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedClaudeAgentSDKInstrumentation(claudeAgentSDK));
