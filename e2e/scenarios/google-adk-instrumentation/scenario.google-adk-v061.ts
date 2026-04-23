import * as adk from "google-adk-sdk-v061";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedGoogleADKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedGoogleADKInstrumentation(adk));
