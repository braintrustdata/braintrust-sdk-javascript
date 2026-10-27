import { runMain } from "../../helpers/scenario-runtime";
import {
  loadMCPModules,
  runWrappedMCPInstrumentation,
} from "./scenario.impl.mjs";

runMain(async () => {
  const mcp = await loadMCPModules((specifier: string) => import(specifier));
  await runWrappedMCPInstrumentation(mcp);
});
