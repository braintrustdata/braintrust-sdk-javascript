import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGenkitInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoGenkitInstrumentation());
