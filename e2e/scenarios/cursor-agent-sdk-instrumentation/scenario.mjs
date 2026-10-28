import { runMain } from "../../helpers/provider-runtime.mjs";
import { runCursorAgentSDKInstrumentation } from "./scenario.impl.mjs";

runMain(() => runCursorAgentSDKInstrumentation());
