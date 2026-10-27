import { runMain } from "../../helpers/provider-runtime.mjs";
import { loadMCPModules, runAutoMCPInstrumentation } from "./scenario.impl.mjs";

const mcp = await loadMCPModules((specifier) => import(specifier));

runMain(async () => runAutoMCPInstrumentation(mcp));
