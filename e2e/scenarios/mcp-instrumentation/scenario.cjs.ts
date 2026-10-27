import { createRequire } from "node:module";
import { runMain } from "../../helpers/scenario-runtime";
import {
  loadMCPModules,
  runWrappedMCPInstrumentation,
} from "./scenario.impl.mjs";

const require = createRequire(import.meta.url);

runMain(async () => {
  const mcp = await loadMCPModules(require);
  await runWrappedMCPInstrumentation(mcp);
});
