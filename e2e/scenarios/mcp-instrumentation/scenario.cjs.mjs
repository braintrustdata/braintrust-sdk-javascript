import { createRequire } from "node:module";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { loadMCPModules, runAutoMCPInstrumentation } from "./scenario.impl.mjs";

const require = createRequire(import.meta.url);
const mcp = await loadMCPModules(require);

runMain(async () => runAutoMCPInstrumentation(mcp));
