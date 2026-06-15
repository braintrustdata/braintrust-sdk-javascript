import * as piCodingAgent from "pi-coding-agent-v079";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoPiCodingAgentInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoPiCodingAgentInstrumentation(piCodingAgent));
