import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedGenkitInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedGenkitInstrumentation());
