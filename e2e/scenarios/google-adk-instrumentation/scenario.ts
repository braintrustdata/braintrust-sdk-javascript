import * as adk from "@google/adk";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedGoogleADKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedGoogleADKInstrumentation(adk));
