const packageName =
  process.env.PI_CODING_AGENT_PACKAGE_NAME ?? "pi-coding-agent-v0-latest";
const piCodingAgent = await import(packageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedPiCodingAgentInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedPiCodingAgentInstrumentation(piCodingAgent));
