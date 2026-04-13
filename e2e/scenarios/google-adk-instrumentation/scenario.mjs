import * as adk from "@google/adk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGoogleADKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoGoogleADKInstrumentation(adk));
